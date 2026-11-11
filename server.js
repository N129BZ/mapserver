
import express from 'express';
import cors from 'cors';
import { readFile, mkdir, readdir, rename, rm, writeFile } from 'fs/promises';
import fs from 'node:fs';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { cwd } from 'node:process';
import sqlite from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { atan, exp, pi, pow } from 'mathjs';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import * as yaml from 'js-yaml';
         
//////////////////////////////////////////////////////////////
// Download link for airport, runway, and frequency csv data:
//    https://davidmegginson.github.io/ourairports-data/
//////////////////////////////////////////////////////////////

const DBEngine = sqlite.Database || sqlite.DatabaseSync;
if (!DBEngine) {
    throw new Error("This application requires Node.js v24+ with native SQLite support.");
}

let appdir = import.meta.dirname || cwd();

/**
 * Utility to see if we are in a docker container
 * @returns boolean
 */
function isRunningInDocker() {
    let indocker = false;
    try {
        let r = fs.readFileSync("/proc/1/cgroup", { encoding: "utf8" });
        indocker = (r.search("/docker/") > -1 || r.search("/containerd/") > -1);
    }
    catch { }
    if (!indocker) {
        indocker = fs.existsSync("/.dockerenv") || process.env.DOCKER === "true";
    }
    if (indocker) {
        console.log("Running in docker!");
        appdir = "/mapserver";
    }
    return indocker;
}

/**
 * Check if a given directory path is backed by an external volume mount
 * @param {string} dirPath
 * @returns boolean
 */
function isExternalMount(dirPath) {
    const resolved = path.resolve(dirPath);
    try {
        const mountInfo = fs.readFileSync("/proc/self/mountinfo", "utf8");
        const isMountPoint = mountInfo.split("\n").some((line) => {
            const fields = line.split(" ");
            return fields.length >= 5 && fields[4] === resolved;
        });
        if (isMountPoint) {
            return true;
        }
    } catch { }
    try {
        if (fs.existsSync(resolved) && fs.existsSync(appdir)) {
            return fs.statSync(resolved).dev !== fs.statSync(appdir).dev;
        }
    } catch { }
    return false;
}

/**
 * Ensure a folder exists and resolve between external volume and internal fallback
 * @param {string} folderName
 * @param {boolean} indocker
 * @returns {string} resolved folder path
 */
function resolveFolder(folderName, indocker) {
    const folderPath = path.resolve(appdir, folderName);
    if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
    }
    if (indocker) {
        if (isExternalMount(folderPath)) {
            console.log(`[${folderName}] External volume detected at ${folderPath}`);
        } else {
            console.log(`[${folderName}] No external volume detected; using internal folder ${folderPath}`);
        }
    }
    return folderPath;
}

/**
 * Resolve tiles folder, falling back to internal bundled tiles if an empty volume is mounted
 * @param {boolean} indocker
 * @returns {string} resolved tiles path
 */
function resolveTilesFolder(indocker) {
    const tilePath = resolveFolder("tiles", indocker);
    const hasTileDbs = (dir) => {
        try {
            return fs.readdirSync(dir).some((f) => f.endsWith(".db") || f.endsWith(".mbtiles"));
        } catch {
            return false;
        }
    };

    if (!hasTileDbs(tilePath)) {
        const internalTilesPath = path.resolve(appdir, "tiles_internal");
        if (fs.existsSync(internalTilesPath) && hasTileDbs(internalTilesPath)) {
            console.log(`[tiles] No databases found in ${tilePath}; falling back to internal tiles at ${internalTilesPath}`);
            return internalTilesPath;
        }
    }
    return tilePath;
}

let isdocker = isRunningInDocker();

const COOKIE_SECRET = '9a7b78421d53bebd3d345f548fd7e3384b27df46d4c76385e58233ada5e59f76';
const clientDist = path.resolve(appdir, "client", "dist");
const ROOT_PATH = fs.existsSync(clientDist) ? clientDist : path.resolve(appdir, "dist");
const TILE_PATH = resolveTilesFolder(isdocker);
const WEATHER_PATH = path.resolve(appdir, "weather");
const RADAR_CACHE_DIR = path.join(WEATHER_PATH, "radar_cache");
const RADAR_SEQUENCE_FILE = path.join(WEATHER_PATH, "radar_sequence.json");
if (!fs.existsSync(WEATHER_PATH)) {
    fs.mkdirSync(WEATHER_PATH, { recursive: true });
}
if (!fs.existsSync(RADAR_CACHE_DIR)) {
    fs.mkdirSync(RADAR_CACHE_DIR, { recursive: true });
}
const airportdb = new DBEngine(path.resolve(appdir, "airports.db"), { readonly: true });
const connections = new Map();
const databaselist = new Map();

/**
 * Parse YAML config file into a settings object.
 * @param {string} filePath
 * @returns {object}
 */
function loadConfig(filePath) {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = yaml.load(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Invalid configuration structure in ${filePath}`);
    }
    return parsed;
}

let configpath = path.join(appdir, "config.yml");
if (isdocker) {
    const externalConfigDir = resolveFolder("config", isdocker);
    const externalConfigPath = path.join(externalConfigDir, "config.yml");
    if (!fs.existsSync(externalConfigPath)) {
        const legacySettingsPath = path.join(externalConfigDir, "settings.json");
        if (fs.existsSync(legacySettingsPath)) {
            const migrated = JSON.parse(fs.readFileSync(legacySettingsPath, "utf-8"));
            fs.writeFileSync(externalConfigPath, yaml.dump(migrated, { indent: 2 }), "utf-8");
            console.log(`Migrated legacy ${legacySettingsPath} to ${externalConfigPath}`);
        } else {
            fs.copyFileSync(configpath, externalConfigPath);
        }
    }
    configpath = externalConfigPath;
}
const configuration = loadConfig(configpath);

function loadDatabaseList() {
    try {
        const dbfiles = fs.readdirSync(TILE_PATH);
        dbfiles.forEach((dbname) => {
            if (dbname.endsWith(".db") || dbname.endsWith(".mbtiles")) {
                var key = dbname.toLowerCase().split(".")[0];
                var dbfile = path.resolve(TILE_PATH, dbname);
                databaselist.set(key, dbfile);
            }
        });
    }
    catch (err) {
        console.log("NO CHART DATABASES FOUND!!");
    }
}

const databases = new Map();
function loadDatabases() {
    try {
        databaselist.forEach((dbfile, key) => {
            console.log(dbfile);
            const db = new DBEngine(dbfile, { readonly: true });
            databases.set(key, db);
        });
    }
    catch (err) {
        console.log(err);
    }
}

/**
 * Get Map object filled with metadata sets for all mbtiles databases
 */
const metadatasets = new Map();
function loadMetadatasets() {
    const sql = `SELECT name, value FROM metadata UNION SELECT 'minzoom', min(zoom_level) FROM tiles
                 WHERE NOT EXISTS (SELECT * FROM metadata WHERE name='minzoom') UNION SELECT 'maxzoom', max(zoom_level) FROM tiles
                 WHERE NOT EXISTS (SELECT * FROM metadata WHERE name='maxzoom')`;

    databases.forEach((db, key) => {
        let item = {};
        item["bounds"] = "";
        item["attribution"] = "";
        let found = false;

        const query = db.prepare(sql);
        for (const row of query.iterate()) {
            if (row.value != null) {
                item[row.name] = row.value;
            }
            if (row.name === "maxzoom" && row.value != null) {
                const maxZoomInt = parseInt(row.value);
                const sql2 = `SELECT min(tile_column) as xmin, min(tile_row) as ymin,
                              max(tile_column) as xmax, max(tile_row) as ymax
                              FROM tiles WHERE zoom_level = ?`;
                const metadata = db.prepare(sql2).get(maxZoomInt);
                const xmin = metadata.xmin;
                const ymin = metadata.ymin;
                const xmax = metadata.xmax;
                const ymax = metadata.ymax;

                const llmin = tileToDegree(maxZoomInt, xmin, ymin);
                const llmax = tileToDegree(maxZoomInt, xmax + 1, ymax + 1);

                const retarray = `${llmin[0]}, ${llmin[1]}, ${llmax[0]}, ${llmax[1]}`;
                item["bounds"] = retarray;
                found = true;
            }
        }
        if (found) {
            metadatasets.set(key, item);
        }
    });
}

loadDatabaseList();
loadDatabases();
loadMetadatasets();

/**
 * Start the express web server
 */
const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });

(() => {
    try {
        httpServer.on('upgrade', (request, socket, head) => {
            const { pathname } = new URL(request.url, `http://${request.headers.host}`);

            // Route-based checking: Only upgrade if the path matches exactly
            if (pathname === "/api/chartserver-stream") {
                wss.handleUpgrade(request, socket, head, (ws) => {
                    wss.emit('connection', ws, request);
                });
            } else {
                // Destroy connection if it tries to upgrade on an unhandled route
                socket.destroy();
            }
        });

        wss.on('connection', async (ws) => {
            const id = Date.now();
            ws.tag = id;
            connections.set(ws, id);
            console.log(`Websocket connected, id: ${id}`);

            await sendWeatherData();

            ws.on('close', function () {
                connections.delete(ws);
                console.log(`Websocket closed, id: ${ws.tag}`);
            });

            ws.on('message', (data) => {
                console.log(`Received message from client ${ws.tag}: ${data}`);
            });
        });
    }
    catch (err) {
        console.log(err);
    }
})();

app.use(cookieParser(COOKIE_SECRET));
app.use((req, res, next) => {
    // Read the signed cookie. If tampered with, req.signedCookies['anonymous_id'] will be false
    const reqUserId = req.signedCookies['mapuser_id'];

    if (!reqUserId) {
        const userId = randomUUID();

        // Configure the cookie to be secure and inaccessible to client-side scripts
        res.cookie('mapuser_id', userId, {
            signed: true,
            httpOnly: true,
            secure: false, // Set to true if running over HTTPS
            maxAge: 365 * 24 * 60 * 60 * 1000 // 1 year expiry
        });

        // Seed initial state in database for the new user
        const mapstate = {
            center: configuration.defaultposition,
            zoom: configuration.startupzoom,
            rotation: 0,
            layerstates: [],
            radius: 25
        };

        const dttm = new Date().toLocaleString();
        const stmt = mapstatedb.prepare('INSERT INTO user_state (id, state, updated_at) VALUES (?, ?, ?)');
        stmt.run(userId, JSON.stringify(mapstate), dttm);
        console.log("New client record created");
    }
    next();
});

app.use(cookieParser(COOKIE_SECRET));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '10mb' }));
app.use(cors());
const mapstatedb = new DBEngine(path.resolve(appdir, "mapstate.db"));
// Create user state table if it doesn't exist
mapstatedb.exec(`CREATE TABLE IF NOT EXISTS user_state (
                 id TEXT PRIMARY KEY,
                 state TEXT,
                 updated_at TEXT)`);
const appOptions = {
    maxAge: 900000,
    dotfiles: 'ignore',
    etag: false,
    extensions: ['html'],
    index: false,
    redirect: false,
    setHeaders: function (res, path, stat) {
        res.set('x-timestamp', Date.now());
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Surrogate-Control', 'no-store');
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader('Access-Control-Allow-Methods', '*');
        res.setHeader("Access-Control-Allow-Headers", "*");
    }
};

app.use(express.static(ROOT_PATH, appOptions));

app.get('/', (req, res) => {
    res.sendFile(path.resolve(ROOT_PATH, "map.html"));
});

app.get("/api/config", (req, res) => {
    // give client freshly read settings in case of running edits
    const clientsettings = loadConfig(configpath);
    res.json(clientsettings);
});

app.get("/api/radar/sequence", async (req, res) => {
    try {
        const sequence = await getOrRefreshRadarSequence(req.query.refresh === "1");
        const remainingMs = Math.max(0, sequence.expiresAt - Date.now());
        res.setHeader("Cache-Control", `public, max-age=${Math.max(1, Math.floor(remainingMs / 1000))}`);
        res.json({
            fetchedAt: sequence.fetchedAt,
            expiresAt: sequence.expiresAt,
            ttlSeconds: Math.round(sequence.updateIntervalMs / 1000),
            layer: sequence.layer,
            frames: sequence.frames
        });
    } catch (err) {
        console.error("Failed to retrieve radar sequence:", err);
        res.status(502).json({ error: "Failed to retrieve radar animation sequence" });
    }
});

app.get("/api/radar/wms", async (req, res) => {
    try {
        const query = { ...req.query };
        if (!query.TIME && !query.time) {
            const sequence = await getOrRefreshRadarSequence();
            if (sequence.frames.length > 0) {
                query.TIME = sequence.frames[sequence.frames.length - 1];
            }
        }
        const { buffer, contentType, cacheStatus, ttlSeconds } = await getCachedOrFetchRadarTile(query);
        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", `public, max-age=${ttlSeconds}`);
        res.setHeader("X-Radar-Cache", cacheStatus);
        res.send(buffer);
    } catch (err) {
        console.error("Failed to serve radar WMS tile:", err.message);
        res.status(502).json({ error: "Failed to fetch radar tile" });
    }
});

app.get("/databaselist", (req, res) => {
    let databases = [];
    databaselist.forEach((value, key) => {
        databases.push(key);
    });
    res.json(databases);
});

app.get("/airport", (req, res) => {
    handleAirportRequest(req, res);
});

app.get("/airportlist", (req, res) => {
    handleAirportListRequest(req, res);
});

app.get("/api/userdata", (req, res) => {
    const userId = req.signedCookies.mapuser_id;
    if (!userId) {
        return res.status(401).json({ error: "Unauthorized: Missing user identity" });
    }
    try {
        const stmt = mapstatedb.prepare("SELECT state FROM user_state WHERE id = ?");
        const row = stmt.get(userId);

        if (row && row.state) {
            let mapstate = row.state; //JSON.parse(row.state);
            res.json(mapstate);
            console.log(`Succeeded to get user_state for: ${userId}`);
        } else {
            res.json({});
        }
    } catch (err) {
        console.error("Failed to get user_state:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.post("/api/userdata", (req, res) => {
    const userId = req.signedCookies.mapuser_id;
    if (!userId) {
        return res.status(401).json({ error: "Unauthorized: Missing user identity" });
    }

    const newState = JSON.stringify(req.body);
    try {
        const dttm = new Date().toLocaleString()
        const stmt = mapstatedb.prepare(`
            INSERT INTO user_state (id, state, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
        `);
        stmt.run(userId, newState, dttm);

        console.log(`user_state updated successfully for user ${userId}`);
        res.status(204).end();
    }
    catch (err) {
        console.error("Failed to update user_state:", err);
        res.status(500).json({ error: "Failed to persist user state" });
    }
});

app.get("/api/config/edit", (req, res) => {
    res.sendFile(path.resolve(appdir, "configedit.html"));
});

app.post("/api/config/edit", async (req, res) => {
    try {
        // req.body contains the parsed JSON object
        const dataToSave = req.body;
        const filePath = configpath;

        await writeFile(filePath, yaml.dump(dataToSave, { indent: 2 }), 'utf8');

        console.log(`config.yml successfully written to ${filePath}`);

        return res.status(200).json({ message: 'File written successfully' });

    } catch (error) {
        console.error('Error writing file:', error);
        return res.status(500).json({ error: 'Internal server error failed to write file' });
    }
});

app.get("/metadataset", (req, res) => {
    const dbKey = req.query.db;
    if (!dbKey) {
        res.json({ error: "Missing 'db' query parameter" });
        return;
    }
    const metadata = metadatasets.get(dbKey);
    if (!metadata) {
        res.json({ error: `No metadata found for db '${dbKey}'` });
        return;
    }
    res.json({ key: dbKey, value: metadata });
});

app.get("/tiles/tilesets", (req, res) => {
    const result = {};
    metadatasets.forEach((item, key) => {
        result[key] = item;
    });
    res.json(result);
});

app.get("/tiles/*", (req, res) => {
    const path = req.path;
    const parts = path.split("/");

    if (parts.length < 6) {
        res.send("Invalid tile URL").end();
        return;
    }

    const dbname = parts[2];
    const z = parseInt(parts[3]);
    const x = parseInt(parts[4]);
    const yRaw = parts[5];
    const y = parseInt(yRaw.split(".")[0]);
    const db = databases.get(dbname);

    if (!db) {
        res.send("Database not found").end();
        return;
    }
    loadTile(z, x, y, res, db);
});

function handleAirportListRequest(req, res) {
    const {
        minLat: minLatStr,
        maxLat: maxLatStr,
        minLon: minLonStr,
        maxLon: maxLonStr
    } = req.query;

    //console.log(req.query);

    // Set default headers
    res.setHeader('Content-Type', 'application/json');

    // Check if all geographic bounds are present
    if (!minLatStr || !maxLatStr || !minLonStr || !maxLonStr) {
        res.json({});
        return;
    }

    // Parse coordinates to floats
    const minLat = parseFloat(minLatStr);
    const maxLat = parseFloat(maxLatStr);
    const minLon = parseFloat(minLonStr);
    const maxLon = parseFloat(maxLonStr);

    if ([minLat, maxLat, minLon, maxLon].some(isNaN)) {
        res.json({});
        return;
    }

    try {
        let sql =
            `SELECT airports.ident,airports.name,airports.type,airports.longitude_deg AS lon,` +
            `airports.latitude_deg AS lat,airports.elevation_ft AS elevation,airports.wikipedia_link, ` +
            `(SELECT json_group_array(json_object('frequency',frequency_mhz,'description',description)) ` +
            `FROM frequencies WHERE frequencies.airport_ident = airports.ident) AS frequencies, ` +
            `(SELECT json_group_array(json_object('length',length_ft,'width',width_ft,` +
            `'surface',surface,'le_ident',le_ident,'he_ident',he_ident)) ` +
            `FROM runways WHERE runways.airport_ident = airports.ident) AS runways ` +
            `FROM airports WHERE airports.latitude_deg BETWEEN ${minLat} AND ${maxLat} ` +
            `AND airports.longitude_deg BETWEEN ${minLon} AND ${maxLon} `;

        if (!configuration.getHeliports) {
            sql += `AND type NOT LIKE '%heliport%' AND UPPER(name) NOT LIKE '%HELIPORT%' `;
        }

        if (!configuration.getClosedAirports) {
            sql += `AND type NOT LIKE '%closed%' AND UPPER(name) NOT LIKE '%CLOSED%'; `;
        }

        try {
            const rows = airportdb.prepare(sql).all();
            // Convert the SQLite JSON strings into native JS Arrays for all returned airports
            const mappedRows = rows.map(airport => ({
                ...airport,
                frequencies: airport.frequencies ? JSON.parse(airport.frequencies) : [],
                runways: airport.runways ? JSON.parse(airport.runways) : []
            }));

            if (rows) {
                res.json(mappedRows);
            }
            else {
                res.json({});
            }
        }
        catch (err) {
            console.log("Error in handleAirportRequest", err);
            res.json({});
        }
    }
    catch (err) {
        console.log("Error in handleAirportListRequest", err);
        res.json({});
    }
};

const envHttpPort = parseInt(process.env.HTTP_PORT, 10);
const listenPort = Number.isInteger(envHttpPort) && envHttpPort > 0 && envHttpPort <= 65535
    ? envHttpPort
    : (parseInt(configuration.httpport, 10) || 8600);

httpServer.listen(listenPort, '0.0.0.0', () => {
    console.log(`Server listening on port ${listenPort}`);
});

async function handleAirportRequest(req, res) {
    const id = req.query.id;
    res.setHeader('Content-Type', 'application/json');
    let sql =
        `SELECT airports.ident,airports.name,airports.type,airports.longitude_deg AS lon,
         airports.latitude_deg AS lat,airports.elevation_ft AS elevation,airports.wikipedia_link,
         (SELECT json_group_array(json_object('frequency',frequency_mhz,'description',description))
            FROM frequencies WHERE frequencies.airport_ident = airports.ident) AS frequencies, 
         (SELECT json_group_array(json_object('length',length_ft,'width',width_ft,
                'surface',surface,'le_ident',le_ident,'he_ident',he_ident)) 
            FROM runways WHERE runways.airport_ident = airports.ident) AS runways
         FROM airports WHERE airports.ident = ?`;

    try {
        const airport = airportdb.prepare(sql).get(id);
        if (airport) {
            airport.frequencies = JSON.parse(airport.frequencies);
            airport.runways = JSON.parse(airport.runways);
            res.json(airport);
        }
        else {
            res.json({});
        }
    }
    catch (err) {
        console.log("Error in handleAirportRequest", err);
        res.json({});
    }
}

/**
 * Parse the z,x,y integers, validate, and pass along to loadTile
 * @param {request} http request 
 * @param {response} http response 
 * @param {db} database 
 * @returns the results of calling loadTile
 */
function handleTile(request, response) {
    try {
        const dbname = request.params.dbname;
        const z = parseInt(request.params.z);
        const x = parseInt(request.params.x);
        // Handle y with possible extension (e.g., "11.png")
        let yRaw = request.params.y;
        let y = parseInt(yRaw.split(".")[0]);
        const db = databases.get(dbname);
        if (!db) {
            response.status(404).send("Database not found");
            return;
        }
        loadTile(z, x, y, response, db);
    } catch (err) {
        response.status(500).send("Failed to parse tile parameters").end();
    }
}

/**
 * Get all tiles from the passed database that match the supplied 
 * z,x,y indices and then send them back to the requesting client   
 * @param {integer} z 
 * @param {integer} x 
 * @param {integer} y 
 * @param {http response} http response object 
 * @param {Database} sqlite database
 */
function loadTile(z, x, y, response, db) {
    if (isNaN(z) || isNaN(x) || isNaN(y)) {
        response.writeHead(400);
        response.end("Invalid tile coordinates");
        return;
    }
    try {
        // Use a prepared statement for safety and correctness
        const stmt = db.prepare(
            "SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?"
        );
        const row = stmt.get(z, x, y); // Pass parameters directly

        if (!row || !row.tile_data) {
            response.writeHead(404);
            response.end();
        } else {
            response.writeHead(200);
            response.write(row.tile_data);
            response.end();
        }
    }
    catch (err) {
        //console.error("Error in loadTile", err);
        response.writeHead(500);
        response.end();
    }
}

/**
 * Get the longitude and latitude for a given pixel position on the map
 * @param {integer} z - the zoom level 
 * @param {integer} x - the horizontal index
 * @param {integer} y - the vertical index
 * @returns 2 element array - [longitude, latitude]
 */
function tileToDegree(z, x, y) {
    y = (1 << z) - y - 1
    let n = pi - 2.0 * pi * y / pow(2, z);
    let lat = 180.0 / pi * atan(0.5 * (exp(n) - exp(-n)));
    let lon = x / pow(2, z) * 360.0 - 180.0;
    return [lon, lat]
}

// Helper function for sleeping
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendWeatherData() {
    const sources = ["metars", "tafs", "aircraftreports"];
    for (const source of sources) {
        const filePath = path.resolve(WEATHER_PATH, `${source}.json`);
        if (!fs.existsSync(filePath)) {
            continue;
        }
        const jsonData = await getJsonDataFromFile(filePath);
        const responseData = jsonData?.response?.data;
        if (responseData) {
            await sendMessageToClients(JSON.stringify(responseData));
        }
    }
}

/**
 * Iterate through any/all connected clients and send data
 * @param {string} stringified json message 
 */
async function sendMessageToClients(jsonstring) {
    [...connections.keys()].forEach((client) => {
        client.send(jsonstring);
    });
}

/**
 * Reads a local weather JSON file and extracts the raw text strings.
 * @param {string} filePath - Path to your local .json file
 * @returns {Promise<Array<string>>}
 */
async function getJsonDataFromFile(filePath) {
    try {
        const fileContent = await readFile(filePath, 'utf8');
        const jsonResponse = JSON.parse(fileContent);
        return jsonResponse;

    } catch (error) {
        console.error(`Error reading file at ${filePath}:`, error);
        return {};
    }
}


/**
 * Download ADDS weather service files
 */
const alwaysArray = [
    'response.data.METAR', // Example matching your METAR array path
    'response.data.TAF',
    'response.data.AircraftReport'
];
const xmlParseOptions = {
    ignoreAttributes: false,
    attributeNamePrefix: "",
    allowBooleanAttributes: true,
    ignoreDeclaration: true,
    isArray: (name, jpath, isLeafNode, isAttribute) => {
        if (alwaysArray.indexOf(jpath) !== -1) {
            return true;
        }
        return false;
    }
};
const xmlparser = new XMLParser(xmlParseOptions);

async function downloadAndExtractXML() {
    const sources = ["metars", "tafs", "aircraftreports"];

    if (!fs.existsSync(WEATHER_PATH)) {
        fs.mkdirSync(WEATHER_PATH, { recursive: true });
    }

    for (const source of sources) {
        const url = configuration.addscurrentwxurl.replace("###", source);
        const outputTmp = path.resolve(WEATHER_PATH, `${source}.json.tmp`);
        const outputFile = outputTmp.replace(".tmp", "");

        if (shouldDownload(outputFile)) {
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);

                // --- MOVE STREAM DEFINITION INSIDE THE LOOP ---
                let xmlData = "";
                const xmlParserStream = new Transform({
                    transform(chunk, encoding, callback) {
                        xmlData += chunk.toString();
                        callback();
                    },
                    flush(callback) {
                        try {
                            const jsonObj = xmlparser.parse(xmlData);
                            this.push(JSON.stringify(jsonObj, null, 2));
                            callback();
                        } catch (err) {
                            callback(err);
                        }
                    }
                });
                // ----------------------------------------------

                const readableStream = Readable.fromWeb(response.body);
                const decompressionStream = createGunzip();
                const fileStream = fs.createWriteStream(outputTmp);

                console.log(`Downloading and extracting ${source}...`);

                await pipeline(
                    readableStream,
                    decompressionStream,
                    xmlParserStream,
                    fileStream
                );

                console.log(`File saved as: ${source}.json.tmp, renaming as ${source}.json`);
                await rename(outputTmp, outputFile);
                if (connections.size > 0) {
                    await sendWeatherData();
                }
            } catch (err) {
                console.error(`Error processing ${source}:`, err.message);
            }
        }
    }
}

let radarSequenceCache = null;
let radarSequencePromise = null;
const inFlightRadarTiles = new Map();

function getRadarConfig() {
    let cfg = configuration;
    try {
        cfg = loadConfig(configpath);
    } catch { }
    const upstreamUrl = cfg.animatedwxurl || "https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows";
    const defaultLayer = upstreamUrl.includes("mesonet.agron.iastate.edu") ? "nexrad-n0r-wmst" : "conus_bref_qcd";
    const layer = cfg.animatedwxlayer || defaultLayer;
    const fetchMinutes = Number.isFinite(Number(cfg.animatedwxfetchminutes)) && Number(cfg.animatedwxfetchminutes) > 0
        ? Number(cfg.animatedwxfetchminutes)
        : 120;
    const intervalMinutes = Number.isFinite(Number(cfg.wxupdateintervalminutes)) && Number(cfg.wxupdateintervalminutes) > 0
        ? Number(cfg.wxupdateintervalminutes)
        : 30;
    return {
        upstreamUrl,
        layer,
        fetchMinutes,
        updateIntervalMs: intervalMinutes * 60 * 1000
    };
}

function parseIsoStepMs(stepToken) {
    const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(String(stepToken || "").trim());
    if (!match) return 0;
    const hours = Number(match[1] || 0);
    const mins = Number(match[2] || 0);
    const secs = Number(match[3] || 0);
    return ((hours * 60 + mins) * 60 + secs) * 1000;
}

function parseDimensionText(rawText) {
    const tokens = String(rawText || "").split(",").map((s) => s.trim()).filter(Boolean);
    const timestamps = [];
    for (const token of tokens) {
        if (token.includes("/")) {
            const [startStr, endStr, stepStr] = token.split("/");
            const startMs = Date.parse(startStr);
            const endMs = Date.parse(endStr);
            const stepMs = parseIsoStepMs(stepStr) || 5 * 60 * 1000;
            if (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs <= endMs) {
                for (let t = startMs; t <= endMs; t += stepMs) {
                    timestamps.push(new Date(t).toISOString());
                }
            }
        } else {
            const ms = Date.parse(token);
            if (Number.isFinite(ms)) {
                timestamps.push(token);
            }
        }
    }
    return timestamps;
}

function extractTimeDimensionValues(node, targetLayer) {
    let fallbackValues = [];
    function visit(layerNode) {
        if (!layerNode) return null;
        const list = Array.isArray(layerNode) ? layerNode : [layerNode];
        for (const item of list) {
            if (!item || typeof item !== "object") continue;
            const dims = item.Dimension ? (Array.isArray(item.Dimension) ? item.Dimension : [item.Dimension]) : [];
            const timeDim = dims.find((d) => String(d?.["@_name"] || d?.name || "").toLowerCase() === "time");
            const dimText = typeof timeDim === "string" ? timeDim : timeDim?.["#text"];
            if (dimText) {
                const parsed = parseDimensionText(dimText);
                if (parsed.length > 0) {
                    if (item.Name === targetLayer) return parsed;
                    if (fallbackValues.length === 0) fallbackValues = parsed;
                }
            }
            if (item.Layer) {
                const nested = visit(item.Layer);
                if (nested) return nested;
            }
        }
        return null;
    }
    const exactMatch = visit(node?.WMS_Capabilities?.Capability?.Layer || node?.WMT_MS_Capabilities?.Capability?.Layer);
    return exactMatch || fallbackValues;
}

function sampleRadarFrames(rawValues, fetchMinutes, stepMinutes = 5) {
    const byMs = new Map();
    for (const val of rawValues) {
        const ms = Date.parse(val);
        if (Number.isFinite(ms)) {
            byMs.set(ms, val);
        }
    }
    const sortedMs = Array.from(byMs.keys()).sort((a, b) => a - b);
    if (sortedMs.length === 0) return [];

    const latestMs = sortedMs[sortedMs.length - 1];
    const cutoffMs = latestMs - fetchMinutes * 60 * 1000;
    const windowMs = sortedMs.filter((ms) => ms >= cutoffMs);
    if (windowMs.length === 0) return [byMs.get(latestMs)];

    const stepMs = stepMinutes * 60 * 1000;
    const sampled = [];
    let lastKeptMs = -Infinity;
    for (const ms of windowMs) {
        if (ms - lastKeptMs >= stepMs * 0.85) {
            sampled.push(byMs.get(ms));
            lastKeptMs = ms;
        }
    }
    const latestStr = byMs.get(latestMs);
    if (sampled[sampled.length - 1] !== latestStr) {
        sampled.push(latestStr);
    }
    return sampled;
}

function buildFallbackRadarFrames(fetchMinutes, stepMinutes = 5) {
    const stepMs = stepMinutes * 60 * 1000;
    const endMs = Math.floor(Date.now() / stepMs) * stepMs;
    const startMs = endMs - fetchMinutes * 60 * 1000;
    const frames = [];
    for (let t = startMs; t <= endMs; t += stepMs) {
        frames.push(new Date(t).toISOString());
    }
    return frames;
}

function sanitizeRadarFrameDir(timeValue) {
    const cleaned = String(timeValue || "latest").replace(/[^A-Za-z0-9._-]/g, "_");
    return cleaned || "latest";
}

async function pruneStaleRadarCache(validFrames) {
    const validDirs = new Set(validFrames.map(sanitizeRadarFrameDir));
    try {
        const entries = await readdir(RADAR_CACHE_DIR, { withFileTypes: true });
        await Promise.all(
            entries
                .filter((entry) => entry.isDirectory() && !validDirs.has(entry.name))
                .map((entry) => rm(path.join(RADAR_CACHE_DIR, entry.name), { recursive: true, force: true }))
        );
    } catch (err) {
        console.warn("Failed to prune stale radar cache:", err.message);
    }
}

async function refreshRadarSequence(cfg) {
    const sep = cfg.upstreamUrl.includes("?") ? "&" : "?";
    const capUrl = `${cfg.upstreamUrl}${sep}service=WMS&version=1.3.0&request=GetCapabilities`;
    let frames = [];

    try {
        const response = await fetch(capUrl, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} from ${capUrl}`);
        }
        const xmlText = await response.text();
        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
        const parsedXml = parser.parse(xmlText);
        const rawTimes = extractTimeDimensionValues(parsedXml, cfg.layer);
        frames = sampleRadarFrames(rawTimes, cfg.fetchMinutes, 5);
        console.log(`Cached NOAA radar sequence (${frames.length} frames) for ${cfg.layer}, next refresh in ${Math.round(cfg.updateIntervalMs / 60000)} mins.`);
    } catch (err) {
        console.warn(`GetCapabilities fetch failed (${err.message}); checking existing sequence or fallback.`);
        if (radarSequenceCache && radarSequenceCache.frames?.length > 0) {
            frames = radarSequenceCache.frames;
        }
    }

    if (frames.length === 0) {
        frames = buildFallbackRadarFrames(cfg.fetchMinutes, 5);
    }

    const now = Date.now();
    const nextSequence = {
        fetchedAt: now,
        expiresAt: now + cfg.updateIntervalMs,
        updateIntervalMs: cfg.updateIntervalMs,
        upstreamUrl: cfg.upstreamUrl,
        layer: cfg.layer,
        frames
    };

    radarSequenceCache = nextSequence;
    await writeFile(RADAR_SEQUENCE_FILE, JSON.stringify(nextSequence, null, 2), "utf8");
    await pruneStaleRadarCache(frames);
    return nextSequence;
}

async function getOrRefreshRadarSequence(force = false) {
    const cfg = getRadarConfig();

    if (!radarSequenceCache && fs.existsSync(RADAR_SEQUENCE_FILE)) {
        try {
            radarSequenceCache = JSON.parse(fs.readFileSync(RADAR_SEQUENCE_FILE, "utf8"));
        } catch { }
    }

    const isValidCache = !force
        && radarSequenceCache
        && Date.now() < radarSequenceCache.expiresAt
        && radarSequenceCache.upstreamUrl === cfg.upstreamUrl
        && radarSequenceCache.layer === cfg.layer
        && Array.isArray(radarSequenceCache.frames)
        && radarSequenceCache.frames.length > 0;

    if (isValidCache) {
        return radarSequenceCache;
    }

    if (!radarSequencePromise) {
        radarSequencePromise = refreshRadarSequence(cfg).finally(() => {
            radarSequencePromise = null;
        });
    }
    return radarSequencePromise;
}

async function getCachedOrFetchRadarTile(query) {
    const cfg = getRadarConfig();
    const ttlSeconds = Math.max(60, Math.round(cfg.updateIntervalMs / 1000));
    const allowedKeys = ["SERVICE", "VERSION", "REQUEST", "FORMAT", "TRANSPARENT", "LAYERS", "TILED", "TIME", "WIDTH", "HEIGHT", "CRS", "SRS", "BBOX", "STYLES"];
    const params = new URLSearchParams();
    const normalized = {};

    for (const [k, v] of Object.entries(query)) {
        const upper = k.toUpperCase();
        if (allowedKeys.includes(upper) && v !== undefined && v !== null) {
            normalized[upper] = String(v);
        }
    }
    if (!normalized.SERVICE) normalized.SERVICE = "WMS";
    if (!normalized.REQUEST) normalized.REQUEST = "GetMap";
    if (!normalized.LAYERS) normalized.LAYERS = cfg.layer;

    for (const key of Object.keys(normalized).sort()) {
        params.set(key, normalized[key]);
    }

    const canonicalKey = params.toString();
    const tileHash = createHash("sha256").update(canonicalKey).digest("hex").slice(0, 24);
    const frameDir = path.join(RADAR_CACHE_DIR, sanitizeRadarFrameDir(normalized.TIME));
    const tilePath = path.join(frameDir, `${tileHash}.png`);

    try {
        const cachedBuffer = await readFile(tilePath);
        return { buffer: cachedBuffer, contentType: "image/png", cacheStatus: "HIT", ttlSeconds };
    } catch { }

    if (inFlightRadarTiles.has(canonicalKey)) {
        const buffer = await inFlightRadarTiles.get(canonicalKey);
        return { buffer, contentType: "image/png", cacheStatus: "HIT", ttlSeconds };
    }

    const fetchPromise = (async () => {
        const sep = cfg.upstreamUrl.includes("?") ? "&" : "?";
        const upstreamUrl = `${cfg.upstreamUrl}${sep}${canonicalKey}`;
        const response = await fetch(upstreamUrl, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) {
            throw new Error(`Upstream WMS returned HTTP ${response.status}`);
        }
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.toLowerCase().startsWith("image/")) {
            throw new Error(`Upstream WMS returned non-image response (${contentType})`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        await mkdir(frameDir, { recursive: true });
        const tmpPath = `${tilePath}.${randomUUID()}.tmp`;
        await writeFile(tmpPath, buffer);
        await rename(tmpPath, tilePath);
        return buffer;
    })().finally(() => {
        inFlightRadarTiles.delete(canonicalKey);
    });

    inFlightRadarTiles.set(canonicalKey, fetchPromise);
    const buffer = await fetchPromise;
    return { buffer, contentType: "image/png", cacheStatus: "MISS", ttlSeconds };
}

function getWxUpdateIntervalMs() {
    const mins = Number(configuration.wxupdateintervalminutes);
    if (Number.isFinite(mins) && mins > 0) return mins * 60 * 1000;
    const ms = Number(configuration.wxupdateintervalmsec);
    if (Number.isFinite(ms) && ms > 0) return ms;
    return 600000;
}

function shouldDownload(outputPath) {
    var answer = false;
    try {
        const thresholdMs = getWxUpdateIntervalMs();

        // Get file stats
        const stats = fs.statSync(outputPath);
        const fileAgeMs = Date.now() - stats.mtime.getTime();
        if (fileAgeMs > thresholdMs) {
            //console.log(`File is ${Math.round(fileAgeMs / 60000)} minutes old. Updating...`);
            answer = true;
        }
        else {
            console.log(`File is fresh (${Math.round(fileAgeMs / 60000)} mins old). Skipping download.`);
        }
    }
    catch (err) {
        if (err.code === 'ENOENT') {
            console.log('File does not exist. Downloading now...');
            answer = true;
        }
        else {
            throw err;
        }
    }

    return answer;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runDownloads() {
    while (true) {
        try {
            await downloadAndExtractXML();
            if (connections.size > 0) {
                await sendWeatherData();
            }
        } catch (error) {
            console.error("Error in download cycle:", error);
        }

        // Wait cleanly for the specified interval before looping again
        await delay(getWxUpdateIntervalMs());
    }
}

runDownloads();

process.on('exit', () => {
    connections.clear();
    console.log("Connections array cleared.")
});
