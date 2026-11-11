
import express from 'express';
import cors from 'cors';
import { readFile } from 'fs/promises';
import fs from 'node:fs';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { cwd } from 'node:process';
import sqlite from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { atan, exp, pi, pow } from 'mathjs';
import { Transform, Readable } from 'node:stream';
import { rename, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
         
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
if (!fs.existsSync(WEATHER_PATH)) {
    fs.mkdirSync(WEATHER_PATH, { recursive: true });
}
const airportdb = new DBEngine(path.resolve(appdir, "airports.db"), { readonly: true });
const connections = new Map();
const databaselist = new Map();

let settingspath = path.join(appdir, "settings.json");
if (isdocker) {
    const externalConfigDir = resolveFolder("config", isdocker);
    const externalSettingsPath = path.join(externalConfigDir, "settings.json");
    if (!fs.existsSync(externalSettingsPath)) {
        fs.copyFileSync(settingspath, externalSettingsPath);
    }
    settingspath = externalSettingsPath;
}
const settings = JSON.parse(fs.readFileSync(settingspath, "utf-8"));

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
            if (pathname === `${settings.wsroute}`) {
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
            center: settings.defaultposition,
            zoom: settings.startupzoom,
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

app.get("/api/settings", (req, res) => {
    // give client freshly read settings in case of running edits
    const clientsettings = JSON.parse(fs.readFileSync(settingspath, 'utf-8'));
    res.json(clientsettings);
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
        const stmt = mapstatedb.prepare("UPDATE user_state SET state = ?, updated_at = ? WHERE id = ?");
        stmt.run(newState, dttm, userId);

        console.log(`user_state updated successfully for user ${userId}`);
        res.status(204).end();
    }
    catch (err) {
        console.error("Failed to update user_state:", err);
        res.status(500).json({ error: "Failed to persist user state" });
    }
});

app.get("/api/settings/edit", (req, res) => {
    res.sendFile(path.resolve(appdir, "settingsedit.html"));
});

app.post("/api/settings/edit", async (req, res) => {
    try {
        // req.body contains the parsed JSON object
        const dataToSave = req.body;
        const filePath = settingspath;

        await writeFile(filePath, JSON.stringify(dataToSave, null, 2), 'utf8');

        console.log(`settings.json successfully written to ${filePath}`);

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

        if (!settings.getHeliports) {
            sql += `AND type NOT LIKE '%heliport%' AND UPPER(name) NOT LIKE '%HELIPORT%' `;
        }

        if (!settings.getClosedAirports) {
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

httpServer.listen(settings.httpport, '0.0.0.0', () => {
    console.log(`Server listening on port ${settings.httpport}`);
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
        const url = settings.addscurrentwxurl.replace("###", source);
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

function shouldDownload(outputPath) {
    var answer = false;
    try {
        const thresholdMs = settings.wxupdateintervalminutes * 60 * 1000;

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
        await delay(settings.wxupdateintervalminutes * 60 * 1000);
    }
}

runDownloads();

process.on('exit', () => {
    connections.clear();
    console.log("Connections array cleared.")
});
