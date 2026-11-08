////////////////////////////////////////////////////////////////////////////////////////////////
//  NOTE: Data for airports can be downloaded from:
//  https://ourairports.com/data/ (airports.csv, runways.csv, frequencies.csv, navaids.csv)
//  These tables are then imported into airports.db and set up with primary keys and indexes.
//  For best performance the freqeuencies and runways tables should be indexed on the airport 
//  id field, and setup with the foreign keys to the airports id.
////////////////////////////////////////////////////////////////////////////////////////////////

import './map.css';
import 'ol/ol.css';
import 'ol-layerswitcher/dist/ol-layerswitcher.css';
import { Map as OLMap, View } from 'ol';
import TileLayer from 'ol/layer/Tile';
import TileWMS from 'ol/source/TileWMS.js';
import { XYZ } from 'ol/source';
import OSM from 'ol/source/OSM';
import { fromLonLat, toLonLat, transformExtent } from 'ol/proj';
import MapBrowserEvent from 'ol/MapBrowserEvent.js';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Style from 'ol/style/Style';
import Icon from 'ol/style/Icon';
import Overlay from 'ol/Overlay';
import { defaults as defaultControls, ScaleLine } from 'ol/control';
import LayerSwitcher from 'ol-layerswitcher';
import { getAirportsInRadius, decodeRunwaySurface, getAirportObject } from './airportfunctions.js';
import { getCurrentTafFlightCategoryColors } from './tafparsingutility.js';
import { createGeometry } from 'ol/format/Feature.js';

export class FIFOCache {
    constructor(maxSize) {
        this.maxSize = maxSize;
        this.map = new Map();
    }
    set(key, value) {
        // Automatically updates order if key exists
        this.map.delete(key);
        this.map.set(key, value);

        // Snap-evict the oldest entry without looping overhead
        if (this.map.size > this.maxSize) {
            this.map.delete(this.map.keys().next().value);
        }
    }
    get(key) {
        return this.map.get(key);
    }
    // Optional: get all values in insertion order
    values() {
        return Array.from(this.map.values());
    }
};

const mapstate = {
    user_id: "",
    center: [],
    zoom: 0.0,
    rotation: 0.0,
    radius: 0,
    layerstates: [],
};

/**
* Construct all of the application urls 
*/
const URL_LOCATION = location.hostname;
const URL_PORT = location.port;
let URL_HOST_BASE = URL_LOCATION;
if (parseInt(URL_PORT) > 0) {
    URL_HOST_BASE += `:${URL_PORT}`;
}
const URL_HOST_PROTOCOL = 'http://';
const URL_SERVER = `${URL_HOST_PROTOCOL}${URL_HOST_BASE}`;
const URL_GET_TILE = `${URL_SERVER}/tiles/{dbname}/{z}/{x}/{-y}`;

/**
 * Set appsettings to default values, 
 * will be updated by server on connect.
 */
let appsettings = "";
let map = null;
let socket = null;
let viewextent = [-180, -85, 180, 85];

const isMobile = /Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

/**
 * global variables
 */
let currentZoom = 9.0;
let selectedRadius = 25; //default value
let currentDblClickLocation = null;
let DistanceUnits = {};
let distanceunit = "";

const { promise, resolve, reject } = Promise.withResolvers();

document.addEventListener('DOMContentLoaded', async function () {
    // Fetch settings asynchronously BEFORE anything else inside the DOM load lifecycle
    try {
        const response = await fetch(`${URL_SERVER}/api/appsettings`);
        if (!response.ok) {
            throw new Error(`Server responded with status: ${response.status}`);
        }
        appsettings = await response.json();
        console.log("App settings loaded:", appsettings);
    } catch (error) {
        console.error("CRITICAL CONFIGURATION ERROR:", error);
        document.body.innerHTML = '';
        const errorContainer = document.createElement('div');
        errorContainer.style.cssText = "font-family: sans-serif; padding: 40px; text-align: center; color: #721c24; background: #f8d7da; border: 1px solid #f5c6cb; margin: 50px auto; max-width: 600px; border-radius: 4px;";
        errorContainer.innerHTML = `
            <h2>Critical Initialization Failure</h2>
            <p>The application could not load configuration profiles and has been halted.</p>
            <p style="font-family: monospace; background: #fff; padding: 10px; border: 1px solid #ddd; color: #333;">${error.message}</p>`;
        document.body.appendChild(errorContainer);
        throw new Error("Application halted due to settings loading failure.");
    }

    document.addEventListener('onreadystatechange', async (event) => {
        if (event.target.readyState === "complete") {
            console.log("Readystate change event complete!")
            await loadUserData()
        }
    });

    /**************** BEGINNING OF SVG GENERATION CLASSES *****************/
    class WeatherProcessItem {
        /**
         * Extracted Metar data in a human readable format.
         * @param weathertext raw metar string if provided station and time will be ignored and replaced with the content in the raw METAR
         * @param station staion name for instance creation
         * @param time time for instance creation
         */
        constructor(weathertext, station, time) {
            this.wind = new Wind();
            this.weather = [];
            this.clouds = [];
            this.station = station ?? "----";
            this.time = time ?? new Date();
            this.flightCategory = "";

            if (weathertext != null) {
                parseWeatherText(weathertext, this);
            }
        }
    }
    class Wind {
        direction = 0;
        speed = 0;
        unit = "";
        constructor() { }
    };
    class Variation {
        constructor() {
        }
    };
    class Cloud {
        constructor() {
        }
    };
    /**************** END OF SVG GENERATION CLASSES *****************/

    // DOM is ready for map.html
    const popup = document.getElementById('popup');
    const popupcontent = document.getElementById('popup-content');
    const radiusSelector = document.getElementById('airport-radius-selector');
    const deflonlat = appsettings.defaultposition;
    const defaultPosition = fromLonLat(deflonlat);

    document.getElementById('radius-header').innerHTML = `Airport Search Radius Selector<hr>` +
                                                         `Double-click on any map location to Search<br>` +
                                                         `Click on an airport dot for Field Information`;


    document.addEventListener('visibilitychange', async function () {
        const vs = document.visibilityState
        try {
            if (vs === 'hidden') {
                await saveUserData();
                await disconnectWebSocket();
            }
            else {
                await loadUserData();
                await scheduleReconnect();
            }
        }
        catch (error) {
            console.log("VISIBILITY CHANGE ERROR", error);
        }
    });

    async function disconnectWebSocket() {
        if (socket) {
            socket.onclose = null;
            socket.close();
            socket = null;
        }
        console.log("WebSocket disconnected...")
        clearTimeout(reconnectTimeout);
    }

    async function scheduleReconnect() {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(() => {
            console.log("Scheduled WebSocket reconnect...")
            startListening();
        }, 5000); // 5-second retry delay (or use exponential backoff)
    }

    async function saveUserData() {
        const view = map.getView();
        const layers = map.getLayers();
        const center = view.getCenter();
        const zoom = view.getZoom();
        const rotation = view.getRotation();

        const layerStates = [];

        // 2. Safely extract visibility states
        layers.forEach((layer) => {
            const layerName = layer.get('name');
            if (layerName) {
                layerStates.push({
                    name: layerName,
                    visible: layer.getVisible()
                });
            }
        });

        mapstate.center = center;
        mapstate.zoom = zoom;
        mapstate.rotation = rotation;
        mapstate.radius = selectedRadius;
        mapstate.layerstates = layerStates;

        try {
            const response = await fetch('/api/userdata', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(mapstate)
            });

            if (!response.ok) {
                throw new Error('Failed to save map state');
            }
            console.log('Map state saved successfully');
        } catch (error) {
            console.error('Error saving map state:', error);
        }
    }

    async function loadUserData() {
        const maplayers = await map.getLayers().getArray();
        const view = map.getView();
        let apvisible = false;

        try {
            const response = await fetch('/api/userdata', {
                credentials: 'include'
            });

            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }

            const rawdata = await response.json();
            const data = JSON.parse(rawdata);

            mapstate.center = data.center;
            mapstate.zoom = data.zoom;
            mapstate.layerstates = data.layerstates;
            mapstate.radius = data.radius;

            if (maplayers && Array.isArray(mapstate.layerstates)) {
                for (const layer of mapstate.layerstates) {
                    try {
                        // Find matching layer by a custom 'name' property
                        const targetLayer = maplayers.find(l => l.get('name') === layer.name);

                        if (targetLayer) {
                            targetLayer.setVisible(layer.visible);
                            if (layer.name === "airports" && layer.visible) {
                                apvisible = true;
                            }
                        } else {
                            console.log(`Layer "${layer.name}" not found in current map!`);
                        }
                    } catch (err) {
                        console.log(`Error updating layer "${layer.name}":`, err);
                    }
                }
            }

            if (mapstate.center && mapstate.zoom) {
                // Check for last position override
                let searchradius = appsettings.defaultsearchradius;
                if (appsettings.overridelastposition) {
                    view.setCenter(defaultPosition);
                    view.setZoom(appsettings.startupzoom);
                } else {
                    view.setCenter(mapstate.center);
                    view.setZoom(parseFloat(mapstate.zoom));
                    searchradius = mapstate.radius;
                }

                if (apvisible) {
                    radiusDropdown.value = mapstate.radius;
                    const lonlat = toLonLat(mapstate.center)
                    await showAirportsInRadius(lonlat[0], lonlat[1], searchradius);
                    view.setZoom(parseFloat(mapstate.zoom));
                }
            } else {
                view.setCenter(defaultPosition);
                view.setZoom(parseFloat(appsettings.startupzoom));
            }
            console.log("Map state restored!");
        } catch (error) {
            console.log(`Error restoring map state: ${error}`);
        }
    }

    let reconnectTimeout = null;
    let airportNameKeymap = new Map();
    let tafFieldKeymap = new Map();
    let metarFieldKeymap = new Map();
    let weatherAcronymKeymap = new Map();
    let icingCodeKeymap = new Map();
    let turbulenceCodeKeymap = new Map();
    let skyConditionKeymap = new Map();

    /**
     * Animation variables 
     */
    let animationId = null;
    let startDate = getTimeThreeHoursAgo();
    let frameRate = 1.0; // frames per second
    const animatecontrol = document.getElementById('wxbuttons');

    /*******keymap loading ******/
    loadTafFieldKeymap();
    loadMetarFieldKeymap();
    loadWeatherAcronymKeymap();
    loadTurbulenceCodeKeymap();
    loadIcingCodeKeymap();
    loadSkyConditionmKeymap();
    /****************************/

    const popupoverlay = new Overlay({
        element: popup,
        autoPan: true,
        autoPanAnimation: { duration: 500 }
    });

    /***********************************
     * WEBSOCKET LISTENER STARTS HERE
     ***********************************/
    async function startListening() {
        // Prevent duplicate connections if one is already active or connecting
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
            console.log("WebSocket already open or connecting. Skipping.");
            return;
        }
        const URL_WEBSOCKET = `${URL_SERVER}${appsettings.wsroute}`;
        //console.log(URL_WEBSOCKET);
        socket = new WebSocket(URL_WEBSOCKET);
        socket.onmessage = async (evt) => {
            const message = JSON.parse(evt.data);

            // Find the key name that holds the array (skipping non-array properties)
            const arrayKey = Object.keys(message).find(key => Array.isArray(message[key]));

            if (arrayKey) {
                // remove all existing features matching the arrayKey
                switch (arrayKey.toLowerCase()) {
                    case "metar":
                        metarVectorLayer.getSource().clear();
                        break;
                    case "taf":
                        tafVectorLayer.getSource().clear();
                        break;
                    case "aircraftreport":
                        pirepVectorLayer.getSource().clear();
                        break;
                }
                const reportArray = message[arrayKey];
                let index = 0;
                // Iterate through the dynamically discovered array
                for (const report of reportArray) {
                    let stationInfo = "";
                    if (report.raw_text) {
                        if (arrayKey) {
                            switch (arrayKey) {
                                case "METAR":
                                    await processMetar(report);
                                    break;
                                case "TAF":
                                    await processTaf(report);
                                    break;
                                default:
                                    await processPirep(report);
                                    break;
                            }
                        }
                    }
                    index++;
                }
            }
            else {
                console.log("No report array found in data.");
            }
        }

        socket.onerror = function (evt) {
            console.log("Websocket ERROR: " + evt.data);
        }

        socket.onopen = function (evt) {
            console.log("Websocket CONNECTED.");
            clearTimeout(reconnectTimeout);
        }

        socket.onclose = function (evt) {
            console.log("Websocket CLOSED.");
            if (document.visibilityState === 'visible') {
                scheduleReconnect();
            }
        }
    }

    /**
     * Check to see if internet is available
     * @returns boolean
     */
    async function checkOnlineStatus() {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1000); // 3-second timeout

        try {
            const response = await fetch('https://google.com', {
            method: 'HEAD',
            mode: 'no-cors', // Prevents CORS errors on web clients
            signal: controller.signal,
            cache: 'no-store' // Prevents browser caching from faking a successful check
            });
            
            clearTimeout(timeoutId);
            return true; // Server responded, client is online
        } catch (error) {
            clearTimeout(timeoutId);
            return false; // Request failed or timed out, client is offline
        }
    }

    const internetAvailable = await checkOnlineStatus();

    /**
     * The scale of miles shown on lower left corner of map
     */
    const scaleLine = new ScaleLine({
        units: 'imperial',
        bar: true,
        steps: 4,
        minWidth: 140
    });

    const viewextent = [-180, -85, 180, 85];
    const extent = transformExtent(viewextent, 'EPSG:4326', 'EPSG:3857');

    map = new OLMap({
        target: 'map',
        view: new View({
            center: defaultPosition,
            zoom: appsettings.startupzoom,
            enableRotation: false,
            minZoom: 1,
            maxZoom: 22,
            visible: true
        }),
        controls: defaultControls().extend([scaleLine])
    });
    map.addOverlay(popupoverlay);

    if (internetAvailable) {
        let osmTileLayer = new TileLayer({
            source: new OSM({
                onTileLoadError: function (event) { } 
            }),
            visible: true,
            type: "none",
            zIndex: 0,
        });
        map.addLayer(osmTileLayer);
    }

    const metarVectorLayer = new VectorLayer({
        source: new VectorSource(),
        title: "Metars",
        name: "metars",
        visible: false,
        zIndex: 99,
        canvasWillReadFrequently: true,
        updateWhileAnimating: false,
        updateWhileInteracting: false
    });
    map.addLayer(metarVectorLayer);

    metarVectorLayer.on('change:visible', async () => {
        const colorLegend = await getWeatherMapLegend();
        if (metarVectorLayer.getVisible()) {
            colorLegend.style.display = 'block';
        }
        else {
            if (!tafVectorLayer.getVisible()) {
                colorLegend.style.display = 'none';
            }
        }
    })

    const tafVectorLayer = new VectorLayer({
        source: new VectorSource(),
        title: "TAFs",
        name: "tafs",
        visible: false,
        zIndex: 99,
        canvasWillReadFrequently: true,
        updateWhileAnimating: false,
        updateWhileInteracting: false
    });
    map.addLayer(tafVectorLayer);

    tafVectorLayer.on('change:visible', async () => {
        const colorLegend = await getWeatherMapLegend();
        if (tafVectorLayer.getVisible()) {
            colorLegend.style.display = 'block';
        }
        else {
            if (!metarVectorLayer.getVisible()) {
                colorLegend.style.display = 'none';
            }
        }
    })

    const pirepVectorSource = new VectorSource({});
    const pirepVectorLayer = new VectorLayer({
        source: pirepVectorSource,
        title: "Pireps",
        name: "pireps",
        visible: false,
        zIndex: 100,
        canvasWillReadFrequently: true,
        updateWhileAnimating: false,
        updateWhileInteracting: false
    });
    map.addLayer(pirepVectorLayer);

    const airportVectorLayer = new VectorLayer({
        title: 'Airports',
        source: new VectorSource(),
        zIndex: 99,
        name: "airports",
        visible: false,
        canvasWillReadFrequently: true,
        updateWhileAnimating: false,
        updateWhileInteracting: false
    });
    map.addLayer(airportVectorLayer);

    airportVectorLayer.on('change:visible', async () => {
        const colorLegend = await getAirportLegend();
        if (airportVectorLayer.getVisible()) {
            radiusSelector.style.display = 'block';
            colorLegend.style.display = 'block';
        }
        else {
            radiusSelector.style.display = 'none';
            colorLegend.style.display = 'none';
        }
    });

    await startListening();

    /**
     * For weather animation, gets the time 3 hours ago
     * @returns Date
     */
    function getTimeThreeHoursAgo() {
        return new Date(Math.round(Date.now() / 3600000) * 3600000 - 3600000 * 3);
    }

    /**
    * Tile source for animated weather
    */
    let animatedWxTileSource = null;
    let animatedWxTileLayer = null;
    if (internetAvailable) {
        animatedWxTileSource = new TileWMS({
            attributions: ['Iowa State University'],
            url: appsettings.animatedwxurl,
            params: { 'LAYERS': 'nexrad-n0r-wmst' },
        });

        animatedWxTileLayer = new TileLayer({
            title: "Animated Weather",
            extent: extent,
            source: animatedWxTileSource,
            visible: false,
            zIndex: 12
        });
        map.addLayer(animatedWxTileLayer);
    }

    /**
     * Update the time clock  
     */
    function setTime() {
        if (internetAvailable) {
            startDate.setMinutes(startDate.getMinutes() + 15);
            if (startDate > Date.now()) {
                startDate = getTimeThreeHoursAgo();
            }
            animatedWxTileSource.updateParams({ 'TIME': startDate.toISOString() });
            updateInfo();
        }
    }

    setTime();

    /**
     * Stop the weather radar animation
     */
    const stopWeatherRadar = async function () {
        if (animationId !== null) {
            window.clearInterval(animationId);
            animationId = null;
        }
    };

    /**
     * Start the weather radar animation
     */
    const playWeatherRadar = async function () {
        stop();
        animationId = window.setInterval(setTime, 1000 / frameRate);
    };

    /**
     * Animation start button element and event listener
     */
    const startButton = document.getElementById('play');
    startButton.addEventListener('click', playWeatherRadar, false);

    /**
     * Animation stop button element and event listener
     */
    const stopButton = document.getElementById('pause');
    stopButton.addEventListener('click', stopWeatherRadar, false);

    /**
     * For displaying the animation time clock
     */
    function updateInfo() {
        const el = document.getElementById('info');
        el.innerHTML = getLocalTime(startDate.toString());
    }

    if (internetAvailable) {
        animatedWxTileLayer.on('change:visible', async () => {
            let visible = animatedWxTileLayer.get('visible');
            animatecontrol.style.visibility = visible ? 'visible' : 'hidden';
            visible ? await playWeatherRadar() : await stopWeatherRadar()
        });
    }

    async function loadTileDatabases() {
        try {
            const response = await fetch('/tiles/tilesets');
            const dblist = await response.json();

            let extent = transformExtent(viewextent, 'EPSG:4326', 'EPSG:3857');

            if (dblist) {
                const entries = Object.entries(dblist).reverse();
                for (const [dbname, metadata] of entries) {                  
                    const fixdbname = dbname.replace("_", " ")
                    let zOrder = 10;
                    let title = fixdbname;
                    let layertype = "overlay";
                    let visible = false;
                    let displayInSwitcher = true;
                    let zindex = title.toLowerCase().search(/terminal/i) > -1 ? 90 : 80;
                    let createLayer = true;

                    if (metadata.description) {
                        title = metadata.description.replace("_", " ");
                    } 
                    
                    if (metadata.name === "OSM Low Detail") {
                        if (!internetAvailable) {
                            title = "";
                            layertype = "base";
                            zindex = 0;
                            visible = true;
                            displayInSwitcher = false;
                        } else {
                            createLayer = false;
                        }
                    }
                    
                    if (createLayer) {
                        const dburl = URL_GET_TILE.replace("{dbname}", dbname);
                        const layer = new TileLayer({
                            source: new XYZ({
                                onTileLoadError: function (event) { }, // Suppress annoying console 404 errors
                                url: dburl,
                                maxzoom: metadata && metadata.maxzoom ? metadata.maxzoom : undefined,
                                minzoom: metadata && metadata.minzoom ? metadata.minzoom : undefined,
                                attributions: metadata && metadata.attribution ? metadata.attribution : undefined,
                                attributionsCollapsible: false,
                            }),
                            name: fixdbname,
                            title: title,
                            type: layertype,
                            visible: visible,
                            extent: extent,
                            zIndex: zindex,
                            canvasWillReadFrequently: true,
                            displayInLayerSwitcher: displayInSwitcher
                        });
                        map.addLayer(layer);
                    }
                }
            }

        } catch(error) {
            console.log(error);
        }
    }

    const layerSwitcher = new LayerSwitcher({
        tipLabel: 'Layers',
        groupSelectStyle: 'children',
    });
    map.addControl(layerSwitcher);

    /**
     * popup close event handler
     * @returns false!!
     */
    function closePopup() {
        popupoverlay.setPosition(undefined);
        return false;
    }
    window.closePopup = closePopup;

    /**
     * Programmatically triggers a dblclick event on an OpenLayers map instance
     * @param {import("ol/Map").default} map - Your active OpenLayers Map object
     * @param {import("ol/coordinate").Coordinate} coordinate - The coordinate array [x, y] to target
     */
    function triggerMapDoubleClick(coordinate) {
        const pixel = map.getPixelFromCoordinate(coordinate);
        const nativeEvent = new MouseEvent('dblclick', {
            clientX: pixel ? pixel[0] : 0,
            clientY: pixel ? pixel[1] : 0,
            bubbles: true,
            cancelable: true,
        });

        const olEvent = new MapBrowserEvent('dblclick', map, nativeEvent);
        olEvent.coordinate = coordinate;
        olEvent.pixel = pixel;

        map.dispatchEvent(olEvent);
    }

    /**
     * This function returns an object that contains airport feature svg images
     */
    async function getWeatherSvgs() {
        const weatherSvgs = {
            vfr: "",
            mvfr: "",
            lifr: "",
            ifr: ""
        };
        const vfr = getCategoryColors("VFR").bgcolor;
        const mvfr = getCategoryColors("MVFR").bgcolor;
        const lifr = getCategoryColors("LIFR").bgcolor;
        const ifr = getCategoryColors("IFR").bgcolor;
        weatherSvgs.vfr = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">
                                    <circle cx="6" cy="6" r="5" fill="${vfr}" stroke="black" stroke-width="1"/></svg>`;

        weatherSvgs.mvfr = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">
                                    <circle cx="6" cy="6" r="5" fill="${mvfr}" stroke="black" stroke-width="1"/></svg>`;

        weatherSvgs.lifr = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">
                                    <circle cx="6" cy="6" r="5" fill="${lifr}" stroke="black" stroke-width="1"/></svg>`;

        weatherSvgs.ifr = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">
                                    <circle cx="6" cy="6" r="5" fill="${ifr}" stroke="black" stroke-width="1"/></svg>`;
        return weatherSvgs;
    }

    async function getWeatherMapLegend() {
        const weatherSvgs = await getWeatherSvgs();
        let detailhtml = `<table style="width: 100%; border-collapse: collapse;">
                            <tr><td colspan="2" class="radius-header" style="text-align:center">Weather Marker Legend</td></tr>`;
        detailhtml +=
            `<tr><td class="legend-dot-label">VFR</td><td style="text-align:right; padding:6px 8px; border-bottom: 1px solid #e0e0e0;">
                <img src='data:image/svg+xml;utf8,${encodeURIComponent(String(weatherSvgs.vfr).replace(`width="12" height="12"`, `width="20" height="20"`))}'>
                </td></tr>
            <tr><td class="legend-dot-label">MVFR</td><td style="text-align:right; padding:6px 8px; border-bottom: 1px solid #e0e0e0;">
                <img src='data:image/svg+xml;utf8,${encodeURIComponent(String(weatherSvgs.mvfr).replace(`width="12" height="12"`, `width="20" height="20"`))}'>
                </td></tr>
            <tr><td class="legend-dot-label">IFR</td><td style="text-align:right; padding:6px 8px; border-bottom: 1px solid #e0e0e0;">
                <img src='data:image/svg+xml;utf8,${encodeURIComponent(String(weatherSvgs.ifr).replace(`width="12" height="12"`, `width="20" height="20"`))}'>
                </td></tr>
            <tr><td class="legend-dot-label">LIFR</td><td style="text-align:right; padding:6px 8px; border-bottom: 1px solid #e0e0e0;">
                <img src='data:image/svg+xml;utf8,${encodeURIComponent(String(weatherSvgs.lifr).replace(`width="12" height="12"`, `width="20" height="20"`))}'>
                </td></tr>
        </table`;

        const colorLegend = document.getElementById('color-legend');
        colorLegend.style = "display:block;"
        colorLegend.innerHTML = detailhtml;
        return colorLegend;
    }

    // Function to clear airport features
    function clearAirportFeatures() {
        Promise.resolve(airportVectorLayer.getSource().clear());
    }

    // Function to find and display airports within radius
    async function showAirportsInRadius(lon, lat, radiusMiles) {
        try {
            console.log(`showAirportsInRadius: Lon = ${lon}, Lat = ${lat}`)
            // Use the existing getAirportsInRadius function
            const airports = await getAirportsInRadius(lon, lat, radiusMiles);

            if (airports && airports.length > 0) {
                await displayAirportFeatures(airports);
            } else {
                console.log('No airports found in the specified radius');
            }

        } catch (error) {
            console.error('Error fetching airports:', error);
        }
    }

    /**
     * This function returns an object that contains airport feature svg images
     */
    async function getAirportSvgs() {
        const airportSvgs = {
            current: "",
            closed: "",
            closedheliport: "",
            heliport: "",
            seaport: "",
            turf: "",
            uncontrolled: "",
            towered: ""
        };
        airportSvgs.closedheliport = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">
                                            <circle cx="6" cy="6" r="5" fill="red" stroke="black" stroke-width="1"/>
                                            <text x="6" y="6" text-anchor="middle" dominant-baseline="central" font-family="Arial, sans-serif" font-size="7" font-weight="bold" fill="white">H</text>
                                        </svg>`;

        airportSvgs.closed = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">
                                    <circle cx="6" cy="6" r="5" fill="red" stroke="black" stroke-width="1"/>
                                    <text x="6" y="6" text-anchor="middle" dominant-baseline="central" font-family="Arial, sans-serif" font-size="8" font-weight="bold" fill="white">✕</text>
                                </svg>`;

        airportSvgs.heliport = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">
                                    <circle cx="6" cy="6" r="5" fill="white" stroke="black" stroke-width="1"/>
                                    <text x="6" y="6" text-anchor="middle" dominant-baseline="central" font-family="Arial, sans-serif" font-size="7" font-weight="bold" fill="black">H</text>
                                </svg>`;

        airportSvgs.seaport = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">
                                    <circle cx="6" cy="6" r="5" fill="lightblue" stroke="black" stroke-width="1"/>
                                    <text x="6" y="6" text-anchor="middle" dominant-baseline="central" font-family="Arial, sans-serif" font-size="7" font-weight="bold" fill="black">S</text>
                                </svg>`;

        airportSvgs.turf = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">
                                <circle cx="6" cy="6" r="5" fill="green" stroke="black" stroke-width="1"/>
                            </svg>`;

        airportSvgs.towered = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">
                                <circle cx="6" cy="6" r="5" fill="blue" stroke="black" stroke-width="1"/>
                                </svg>`;

        airportSvgs.uncontrolled = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">
                                        <circle cx="6" cy="6" r="5" fill="magenta" stroke="black" stroke-width="1"/>
                                    </svg>`;
        airportSvgs.current = "";
        return airportSvgs;
    }

    async function getAirportLegend() {
        const airportSvgs = await getAirportSvgs();
        const closedhtml = `<tr><td style="padding:6px 8px; border-bottom: 1px solid #e0e0e0;">Closed</td>
                <td style="text-align:right; padding:6px 8px; border-bottom: 1px solid #e0e0e0;">
                <img src='data:image/svg+xml;utf8,${encodeURIComponent(String(airportSvgs.closed).replace(`width="12" height="12"`, `width="20" height="20"`))}'>
                </td></tr>`;
        const helihtml = `<tr><td style="padding:6px 8px; border-bottom: 1px solid #e0e0e0;">Heliport</td>
                <td style="text-align:right; padding:6px 8px; border-bottom: 1px solid #e0e0e0;">
                <img src='data:image/svg+xml;utf8,${encodeURIComponent(String(airportSvgs.heliport).replace(`width="12" height="12"`, `width="20" height="20"`))}'>
                </td></tr>`;

        let detailhtml = `<table style="width: 100%; border-collapse: collapse;">
                            <tr><td colspan="2" class="radius-header" style="text-align:center">Airport Marker Legend</td></tr>`;
        if (appsettings.getClosedAirports) {
            detailhtml += closedhtml;
        }
        if (appsettings.getHeliports) {
            detailhtml += helihtml;
        }
        detailhtml += `<tr><td style="padding:6px 8px; border-bottom: 1px solid #e0e0e0;">Towered</td><td style="text-align:right; padding:6px 8px; border-bottom: 1px solid #e0e0e0;">
                <img src='data:image/svg+xml;utf8,${encodeURIComponent(String(airportSvgs.towered).replace(`width="12" height="12"`, `width="20" height="20"`))}'>
                </td></tr>
            <tr><td style="padding:6px 8px; border-bottom: 1px solid #e0e0e0;">Uncontrolled</td><td style="text-align:right; padding:6px 8px; border-bottom: 1px solid #e0e0e0;">
                <img src='data:image/svg+xml;utf8,${encodeURIComponent(String(airportSvgs.uncontrolled).replace(`width="12" height="12"`, `width="20" height="20"`))}'>
                </td></tr>
            <tr><td style="padding:6px 8px; border-bottom: 1px solid #e0e0e0;">Turf</td><td style="text-align:right; padding:6px 8px; border-bottom: 1px solid #e0e0e0;">
                <img src='data:image/svg+xml;utf8,${encodeURIComponent(String(airportSvgs.turf).replace(`width="12" height="12"`, `width="20" height="20"`))}'>
                </td></tr>
            <tr><td style="padding:6px 8px; border-bottom: 1px solid #e0e0e0;">Seaplane Base</td><td style="text-align:right; padding:6px 8px; border-bottom: 1px solid #e0e0e0;">
                <img src='data:image/svg+xml;utf8,${encodeURIComponent(String(airportSvgs.seaport).replace(`width="12" height="12"`, `width="20" height="20"`))}'>
                </td></tr>
            
            
            
        </table`;

        const colorLegend = document.getElementById('color-legend');
        colorLegend.style = "display:block;"
        colorLegend.innerHTML = detailhtml;
        return colorLegend;
    }

    /**
     * Populate the airport legend object and 
     * display airport features on the map
     * @param {*} airports 
     */
    async function displayAirportFeatures(airportsPromise) {
        const airports = await airportsPromise;

        // Use the existing airport layer
        airportVectorLayer.getSource().clear();

        const airportSvgs = await getAirportSvgs();

        // Add airport features
        const features = airports.map(airport => {
            // Handle different possible property names
            const longitude = airport.longitude_deg || airport.lon;
            const latitude = airport.latitude_deg || airport.lat;
            const name = airport.name || airport.station_name || airport.ident;
            const ident = airport.ident || airport.id;

            if (!longitude || !latitude) {
                console.warn('Airport missing coordinates:', airport);
                return null;
            }

            const frequencies = airport.frequencies;
            const runways = airport.runways;

            // Check if this is a heliport or closed airport
            const isHeliport = (airport.type && airport.type.toLowerCase().includes('heliport')) ||
                (airport.name && airport.name.toLowerCase().includes('heliport'));
            const isClosed = airport.closed === 'yes' || airport.closed === true ||
                (airport.type && airport.type.toLowerCase().includes('closed'));
            const isSeaplane = (airport.type && airport.type.toLowerCase().includes('seaplane')) ||
                (airport.name && airport.name.toLowerCase().includes('seaplane'));
            const hasTower = frequencies && frequencies.some(freq =>
                freq.description && freq.description.includes('TWR'));
            const hasTurfRunway = runways && runways.some(runway => {
                if (!runway.surface) return false;
                const surface = runway.surface.replace(/[\[\]]/g, '').toUpperCase();
                return surface.includes('TURF') ||
                    surface.includes('DIRT') ||
                    surface.includes('GRASS') ||
                    surface.includes('GRS') ||
                    surface.includes('GVL') ||
                    surface.includes('GRAVEL');
            });


            let bgcolor;
            let fgcolor = "white";

            if (appsettings.getClosedAirports && isClosed) {
                bgcolor = "red";
                airportSvgs.current = airportSvgs.closed;
            } else if (appsettings.getHeliports && isHeliport && !isClosed) {
                bgcolor = "white";
                fgcolor = "black";
                airportSvgs.current = airportSvgs.heliport;
            } else if (isSeaplane) {
                bgcolor = "lightblue";
                fgcolor = "black";
                airportSvgs.current = airportSvgs.seaport;
            } else if (hasTurfRunway) {
                bgcolor = "green";
                airportSvgs.current = airportSvgs.turf;
            } else if (hasTower) {
                bgcolor = "blue";
                airportSvgs.current = airportSvgs.towered;
            } else {
                bgcolor = "magenta";
                airportSvgs.current = airportSvgs.uncontrolled;
            }

            let feature = new Feature({
                ident: ident,
                datatype: "AIRPORT",
                name: name,  // Use 'name' instead of 'station_name' for popup compatibility
                bgcolor: bgcolor,
                fgcolor: fgcolor,
                datatype: "AIRPORT",
                elevation_ft: airport.elevation_ft,  // Add elevation field
                geometry: new Point(fromLonLat([longitude, latitude])),
                airport: airport  // Store complete airport object for popup
            });

            // Style the airport marker with appropriate scale
            const scaleSize = getAirportScaleSize();
            feature.setStyle(new Style({
                image: new Icon({
                    src: `data:image/svg+xml;utf8,${encodeURIComponent(airportSvgs.current)}`,
                    scale: scaleSize,
                    anchor: [0.5, 0.5],
                })
            }));

            return feature;

        }).filter(feature => feature !== null); // Remove null features

        airportVectorLayer.getSource().addFeatures(features);
    }

    // Add radius dropdown event listener
    const radiusDropdown = document.getElementById('radius-dropdown');
    radiusDropdown.addEventListener('change', async function () {
        const radius = this.value;

        if (radius === 'clear') {
            Promise.resolve(clearAirportFeatures())
            selectedRadius = 0; // Set to 0 to indicate no search
            this.value = ''; // Reset dropdown to default
            return;
        }

        if (radius === '') {
            promise.resolve(clearAirportFeatures());
            this.value = '';
            return;
        }

        // Store the selected radius
        selectedRadius = parseInt(radius);

        // Only search for airports if a radius is selected (not 0/clear)
        if (selectedRadius > 0 && currentDblClickLocation) {
            let lonlat = [currentDblClickLocation.lon, currentDblClickLocation.lat];
            console.log('Searching for airports within', selectedRadius, 'miles of', lonlat);
            await showAirportsInRadius(lonlat[0], lonlat[1], selectedRadius);
        }
        console.log('Selected radius:', selectedRadius, 'miles');
    });

    async function animate() {
        // Only consume CPU/GPU cycles if the layer is actually turned on
        if (pirepVectorLayer.getVisible()) {
            const timeInSeconds = Date.now() / 1000; // Use system time since we are outside the frameState
            const DEGREES_PER_SECOND = 20;
            const targetRotationSpeed = DEGREES_PER_SECOND * (Math.PI / 180);
            const currentRotation = (timeInSeconds * targetRotationSpeed) % (Math.PI * 2);

            // get the icons rotating and notify the layer to update
            pirepIconStyle.getImage().setRotation(currentRotation);
            pirepVectorLayer.getSource().changed();
            
            // Tell OpenLayers to draw a new frame immediately on the next tick
            map.render();
        }
        // Keep the animation loop running
        requestAnimationFrame(animate);
    }

    /**
     * Call the animate function so when the pirep layer becomes 
     * visible, the feature icons will rotate smoothly
     */
    await animate();

    /**
     * Event to handle scaling of feature images
     */
    map.on('moveend', function (e) {
        let newZoom = map.getView().getZoom();
        if (currentZoom != newZoom) {
            resizeDots(newZoom);
            currentZoom = newZoom;
            closePopup();
        }
    });

    /**
     * Event to view Metar/TAF popup & closure
     */
    map.on('click', async (evt) => {
        let features = [];
        let htol = isMobile ? appsettings.smallScreenHitTolerance : 1;

        map.forEachFeatureAtPixel(evt.pixel, (feature) => {
            if (feature) {
                features.push(feature);
            }
        }, { hitTolerance: htol });

        let handled = false;
        // Prioritize METAR, then TAF, then others
        const metarFeature = features.find(f => f.get('datatype') === 'METAR');
        if (metarFeature) {
            await displayMetarPopup(metarFeature);
            popupoverlay.setPosition(evt.coordinate);
            handled = true;
        }
        else {
            const tafFeature = features.find(f => f.get('datatype') === 'TAF');
            if (tafFeature) {
                await displayTafPopup(tafFeature);
                popupoverlay.setPosition(evt.coordinate);
                handled = true;
            }
            else {
                const pirepFeature = features.find(f => f.get('datatype') === 'PIREP');
                if (pirepFeature) {
                    await displayPirepPopup(pirepFeature);
                    popupoverlay.setPosition(evt.coordinate);
                    handled = true;
                }
                else {
                    const airportFeature = features.find(f => f.get('datatype') === 'AIRPORT');
                    if (airportFeature) {
                        const ident = airportFeature.get("ident");
                        const station_name = airportFeature.get("name");
                        const bgcolor = airportFeature.get("bgcolor");
                        const fgcolor = airportFeature.get("fgcolor");
                        const airport = airportFeature.get("airport");

                        const parameters = {
                            type: "AIRPORT",
                            colors: { bgcolor, fgcolor },
                            station_name: station_name,
                            ident: ident,
                            airport: airport,
                            hascallback: false
                        };

                        await displayAirportPopup(parameters);
                        popupoverlay.setPosition(evt.coordinate);
                        handled = true;
                    }
                }
            }
        }
        if (!handled) {
            closePopup();
        }
    });

    /**
     * Double-click/Double-tap event handler
     */
    map.on('dblclick', async function (evt) {
        const coordinate = evt.coordinate;
        const lonLat = toLonLat(coordinate);

        // Store the clicked location for radius selector
        currentDblClickLocation = {
            lon: lonLat[0],
            lat: lonLat[1]
        };

        // Clear previous airport features
        clearAirportFeatures();

        const radius = parseInt(radiusDropdown.value);

        // Only search for airports if a radius is selected (not 0/clear)
        if (radius > 0) {
            console.log('Searching for airports within', radius, 'miles of', lonLat);
            await showAirportsInRadius(lonLat[0], lonLat[1], radius);
        }
    });

    /**
     * Create the html for a METAR popup element
     * @param {feature} Feature: the metar feature the user clicked on 
     */
    async function displayMetarPopup(feature) {
        const isValidNumber = (val) => (typeof val === 'number' && !Number.isNaN(val)) ? val : "";
        const metar = feature.get("data");
        const rawData = metar.raw_text;
        const ident = metar.station_id;
        const svg = feature.get("svgimage");
        const cat = metar.flight_category ?? "VFR";
        const tempC = metar.temp_c;
        const dewpC = metar.dewpoint_c;
        const temp = isValidNumber(tempC) ? convertCtoF(tempC) : "N/A";
        const dewp = isValidNumber(dewpC) ? convertCtoF(dewpC) : "N/A";
        const windir = metar.wind_dir_degrees ?? "";
        const winspd = metar.wind_speed_kt ?? "0";
        const wingst = metar.wind_gust_kt ?? "0";
        const altim = isValidNumber(metar.altim_in_hg) ? getAltimeterSetting(metar.altim_in_hg) + " hg" : "N/A";
        const vis = metar.visibility_statute_mi ? `${metar.visibility_statute_mi} SM` : "N/A";
        const skycondition = metar.sky_condition;
        const skyconditions = decodeSkyCondition(skycondition ?? "") ?? "";
        const btncolors = getCategoryColors(cat);
        const bgcolor = btncolors.bgcolor;
        const fgcolor = btncolors.fgcolor;
        const rowPrefix = `<tr class="table-row-data">`
        const cellData = `<td style="width:100%;">`;
        const rowSuffix = `</td></tr>`;
        const skyHeader = `<tr><td class="skyheader colspan="2" style="display:block;width:99%;text-align:center;border:1px solid #000000;">`;

        const airport = await getAirportObject(ident);
        const stationName = airport.name !== undefined ? `${String(airport.name).split("/")[0]}<br>${ident} - ${cat}` :`${ident} - ${cat}`;

        let detailhtml = "";
        let time = (function () {
            const thistime = metar.observation_time ? metar.observation_time : metar.timestamp;
            let outtime = "";
            if (appsettings.uselocaltime) {
                outtime = new Date(thistime).toLocaleString('en-US', { timeZoneName: 'short' });
            } else {
                outtime =  thistime.slice(0, 16).replace('T', ' ') + '&nbspZULU';
            }
            return outtime;
        })();

        if (ident != "undefined") {
            detailhtml =
                `<div style="display:block;">
                <span class="popup-title-area" style="background-color:${bgcolor}; color:${fgcolor};">${stationName}</span>
                <div class="popup-content">
                    <div class="table-scroll-container">
                        <table class="popup-body-table" id="metartable">
                           ${rowPrefix}${cellData}Time: ${cellData}<b>${time}</b>${rowSuffix}
                            ${rowPrefix}${cellData}Flight Category: ${cellData}<b>${cat}</b>${rowSuffix}
                            ${rowPrefix}${cellData}Temperature: ${cellData}<b>${tempC} °C (${temp})</b>${rowSuffix}
                            ${rowPrefix}${cellData}Dewpoint: ${cellData}<b>${dewpC} °C (${dewp})</b>${rowSuffix}
                            ${rowPrefix}${cellData}Wind Direction: ${cellData}<b>${windir}°</b>${rowSuffix}
                            ${rowPrefix}${cellData}Wind Speed: ${cellData}<b>${winspd} KT</b>${rowSuffix}
                            ${rowPrefix}${cellData}Wind Gust: ${cellData}<b>${wingst} KT</b>${rowSuffix}
                            ${rowPrefix}${cellData}Altimeter: ${cellData}<b>${altim}</b>${rowSuffix}
                            ${rowPrefix}${cellData}Horizontal Visibility: ${cellData} <b>${vis}</b>${rowSuffix}
                            ${skyHeader}Sky Conditions${rowSuffix} ${skyconditions}
                        </table>
                    </div>    
                    <div class="popup-footer">
                        <div class="popup-button-row" style="display: flex; flex-direction: row; justify-content: space-between; width: 100%;">`;
            if (stationName) {
                detailhtml += `<button class="custom-popup-button" id="airport-info" style="background:${bgcolor}; color:${fgcolor};">Field Info</button>`;
            }
            detailhtml += `<span class="windsvg">${svg}</span>
                            <button class="custom-popup-button" onclick="closePopup()" style="background:${bgcolor}; color:${fgcolor};">Close</button>
                        </div>
                        <textarea id="rawdata" class="rawdata">${rawData}</textarea><br>
                    </div>
                </div>
            </div>`;
        }

        popupcontent.innerHTML = detailhtml;

        if (stationName) {
            // Bind the click event immediately inside the same function scope
            const infoBtn = popupcontent.querySelector('#airport-info');
            if (infoBtn) {

                const parameters = {
                    type: "METAR",
                    colors: { bgcolor, fgcolor },
                    station_name: stationName,
                    ident: ident,
                    airport: airport,
                    hascallback: true
                };

                infoBtn.addEventListener('click', async () => {
                    await displayAirportPopup(parameters, displayMetarPopup, feature);
                });
            }
        }
    }

    /**
     * Create the html for a TAF popup element
     * @param {feature} Feature: the taf feature the user clicked on
     */
    async function displayTafPopup(feature) {
        const taf = feature.get("data");
        const bgcolor = feature.get("bgcolor");
        const fgcolor = feature.get("fgcolor");
        const category = feature.get("category");
        const ident = taf.station_id;
        const rawData = taf.raw_text;
        const forecast = taf.forecast;
        const airport = await getAirportObject(ident);
        const stationNames = String(airport.name).split("/");
        const stationName = stationNames[0] ? `${stationNames[0]}<br>${ident}` : ident;

        let detailhtml = "";
        let innerhtml = `
            <div style="display:block;"> 
                <span class="popup-title-area" 
                      style="background-color:${bgcolor}; color:${fgcolor};">
                      Terminal Area Forecast - ${ident}<br>${category}</span> 
                <div class="popup-content"> 
                    <div class="taf"> 
                        <div class="table-scroll-container"> 
                            <table class="popup-body-table" id="taftable">`;

        // Safe iteration over the forecast fields
        for (const item in forecast) {
            let parsedForecast = "";
            const value = forecast[item];

            if (value && typeof value === 'object') {
                for (const subitem in value) {
                    const subvalue = value[subitem];
                    parsedForecast = parseForecastField(subitem, subvalue);
                    detailhtml += parsedForecast;
                }
            } else {
                parsedForecast = parseForecastField(item, value);
                detailhtml += parsedForecast;
            }
        }

        detailhtml += `
                            </table> 
                        </div> 
                    </div> 
                    <div class="popup-footer"> 
                        <div class="popup-button-row" style="display: flex; flex-direction: row; justify-content: space-between; width: 100%;">`;

        if (stationName) {
            detailhtml += `<button class="custom-popup-button" id="airport-info" style="background:${bgcolor}; color:${fgcolor};">Station Information</button>`;
        }

        detailhtml += `
                            <button class="custom-popup-button" onclick="closePopup()" style="background:${bgcolor}; color:${fgcolor};">Close</button> 
                        </div> 
                        <textarea id="rawdata" class="rawdata">${rawData}</textarea><br> 
                    </div> 
                </div>
            </div>`;

        // Corrected Sequence: Inject HTML into the container first
        innerhtml = innerhtml + detailhtml;
        popupcontent.innerHTML = innerhtml;

        // Corrected Sequence: Query and attach listeners now that elements exist in DOM
        if (stationName) {
            const infoBtn = popupcontent.querySelector('#airport-info');
            if (infoBtn) {

                const parameters = {
                    type: "TAF",
                    colors: { bgcolor, fgcolor, createGeometry },
                    station_name: stationName,
                    ident: ident,
                    airport: airport,
                    hascallback: true
                };

                infoBtn.addEventListener('click', async () => {
                    await displayAirportPopup(parameters, displayTafPopup, feature);
                });
            }
        }
    }

    /**
     * Create the html for a PIREP popup element
     * @param {object} feature: the pirep the user clicked on
     */
    async function displayPirepPopup(feature) {
        const pirep = feature.get("data");
        const rawData = pirep.raw_text;
        const rowPrefix = `<tr class="table-row-data">`
        const cellData = `<td style="width:100%;">`;
        const rowSuffix = `</td></tr>`;
        const skyHeader = `<tr class="airport-subarea"><td class="airport-subarea" colspan="2">`;
        const btncolors = getCategoryColors("pirep");
        const bgcolor = btncolors.bgcolor;
        const fgcolor = btncolors.fgcolor;

        let rt = "";
        let ot = "";
        let detailhtml = "";
        let html =
            `<div style="display:block;">
                <span class="popup-title-area" style="background-color:${bgcolor}; color:${fgcolor};">${pirep.report_type.toUpperCase()} FROM AIRCRAFT: ${pirep.aircraft_ref}</span>
                <div class="popup-content">
                    <div class="pirep">
                        <div class="table-scroll-container">
                           <table class="pireptable" id="pireptable">`;
        for (const item in pirep) {
            const value = pirep[item];
            const fieldname = getFieldDescription(item);
            switch (item) {
                case "receipt_time":
                    rt = value;
                    if (appsettings.uselocaltime) {
                        rt = getLocalTime(value);
                    }
                    detailhtml += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${rt}</b>${rowSuffix}`;
                    break;
                case "observation_time":
                    ot = value;
                    if (appsettings.uselocaltime) {
                        ot = getLocalTime(value);
                    }
                    detailhtml += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${ot}</b>${rowSuffix}`;
                    break;
                case "latitude":
                    detailhtml += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${value}</b>${rowSuffix}`;
                    break;
                case "longitude":
                    detailhtml += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${value}</b>${rowSuffix}`;
                    break;
                case "altitude_ft_msl":
                    detailhtml += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${value}</b>${rowSuffix}`;
                    break;
                case "temp_c":
                    detailhtml += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${value}°</b>${rowSuffix}`;
                    break;
                case "dewpoint_c":
                    detailhtml += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${value}°</b>${rowSuffix}`;
                    break;
                case "time_becoming":
                    detailhtml += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${value}</b>${rowSuffix}`;
                    break;
                case "probability":
                    detailhtml += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${value}</b>${rowSuffix}`;
                    break;
                case "wind_speed_kt":
                    detailhtml += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${value}</b>${rowSuffix}`;
                    break;
                case "wind_gust_kt":
                    detailhtml += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${value}</b>${rowSuffix}`;
                    break;
                case "wind_dir_degrees":
                    detailhtml += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${value}°</b>${rowSuffix}`;
                    break;
                case "wind_shear_dir_degrees":
                    detailhtml += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${value}°</b>${rowSuffix}`;
                    break;
                case "wind_shear_hgt_ft_agl":
                    detailhtml += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${value}</b>${rowSuffix}`;
                    break;
                case "wind_shear_speed_kt":
                    detailhtml += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${value}</b>${rowSuffix}`;
                    break;
                case "vert_vis_ft":
                    detailhtml += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${value}</b>${rowSuffix}`;
                    break;
                case "visibility_statute_mi":
                    detailhtml += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${value}</b>${rowSuffix}`;
                    break;
                case "sky_condition":
                    detailhtml += `${skyHeader}${fieldname}${rowSuffix}
                                                           ${decodeSkyCondition(value)}`;
                    break;
                case "turbulence_intensity":
                    detailhtml += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${value}</b>${rowSuffix}`;
                    break;
                case "turbulence_condition":
                    detailhtml += `${skyHeader}${fieldname}${rowSuffix}
                                                           ${decodeIcingOrTurbulenceCondition(value)}`;
                    break;
                case "icing_condition":
                    detailhtml += `${skyHeader}${fieldname}${rowSuffix}
                                                           ${decodeIcingOrTurbulenceCondition(value)}`;
                    break;
                case "temperature":
                    detailhtml += `${skyHeader}Weather<hr>${rowSuffix}`;
                    break;
                case "altim_in_hg":
                    detailhtml += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${getInchesOfMercury(value)}</b>${rowSuffix}`;
                    break;
                case "wx_string":
                    detailhtml += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${decodeWxDescriptions(value)}</b>${rowSuffix}`;
                    break;
                case "change_indicator":
                    detailhtml += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${getSkyConditionDescription(value)}</b>${rowSuffix}`;;
                    break;
                case "pirep_type":
                case "aircraft_ref":
                case "raw_text":
                default:
                    break;
            }
        }
        detailhtml += ` </table>
                        </div>
                        <div class="popup-footer">
                            <div class="popup-button-row" style="display: flex; flex-direction: row; justify-content: space-between; width: 100%;">
                                <button class="custom-popup-button" onclick="closePopup()" style="margin-left:auto; background:${bgcolor}; color:${fgcolor};">Close</button>
                            </div>
                            <textarea id="rawdata" class="rawdata">${rawData}</textarea><br>
                        </div>
                    </div>
                </div>
            </div>`;
        const innerhtml = html + detailhtml;
        popupcontent.innerHTML = innerhtml;
    }

    /**
     * Display airport popup with detailed information and optional callback to previous popup
     * @param {*} parameters 
     * @param {*} callbackFunction 
     * @param {*} feature 
     */
    async function displayAirportPopup(parameters, callbackFunction, feature) {
        /****************************************************
         *      Example parameters JSON object layout       *
         **************************************************** 
         *             { type: "METAR",                     *
         *               colors: { bgcolor, fgcolor },      *
         *               station_name: stationName,         *
         *               airport: airport,                  *
         *               hascallback: true }                *
         ****************************************************/
        const callertype = parameters.type;
        const bgcolor = parameters.colors.bgcolor;
        const fgcolor = parameters.colors.fgcolor;
        const name = parameters.station_name;
        const ident = parameters.ident;
        const airport = parameters.airport

        const type = airport.type ? airport.type : "UNKNOWN";
        const frequencies = airport.frequencies;
        const runways = airport.runways;
        const hasFrequencies = frequencies ? frequencies.length > 0 : false;
        const hasRunways = runways ? runways.length > 0 : false;

        let html = `<div class="featurepopup" id="featurepopup">`;
        html += `<span class="airportheader" 
                            style="background-color:${bgcolor}; color:${fgcolor}; border: 1px solid black;">${name}</span><br>`;
        `<div class="airport-popup-body">`;

        let frhtml = "";
        let rwhtml = "";
        let aptype = "UNCONTROLLED";
        try {
            // Frequencies section
            if (hasFrequencies) {
                frhtml += `<tr class="airport-subarea"><td colspan="3" class="airport-subarea">Frequencies</td></tr>`;
                for (const freq of frequencies) {
                    frhtml += `<tr style="border-bottom: 1px solid #ddd;">`;
                    if (freq.description && freq.frequency) {
                        if (freq.description === "TWR") {
                            aptype = "TOWERED";
                        }
                        frhtml += `<td colspan="1" class="airport-table-item">${freq.description}</td>`;
                        frhtml += `<td colspan="2" class="airport-table-item"><b>${freq.frequency}</b></td>`;
                    }
                    else {
                        frhtml += `<td colspan="3" class="airport-table-item"></td>`;
                    }
                    frhtml += `</tr>`;
                }
                frhtml += `<tr><td colspan="3" style="height: 12px;"></td></tr>`;
            }

            // Runways section
            if (hasRunways) {
                rwhtml += `<tr class="airport-subarea"><td colspan="3" class="airport-subarea">Runways</td></tr>`;
                for (const runway of runways) {
                    rwhtml += `<tr style="border-bottom: 1px solid #ddd;">`;
                    rwhtml += `<td class="airport-table-item"><b>${runway.le_ident}/${runway.he_ident}</b></td>`;
                    rwhtml += `<td class="airport-table-item">`;
                    if (runway.length > 0 && runway.width > 0) {
                        rwhtml += `<b>${runway.length} ft x ${runway.width} ft</b>`;
                    }
                    rwhtml += `</td>`;
                    rwhtml += `<td class="airport-table-item">`;
                    if (runway.surface.length > 0) {
                        const decodedSurface = decodeRunwaySurface(runway.surface);
                        rwhtml += `<b>${decodedSurface}</b>`;
                    }
                    rwhtml += `</td>`;
                    rwhtml += `</tr>`
                }
            }
        } catch (err) {
            console.error("Error processing airport frequencies or runways:", err);
        }

        // Basic airport information
        html += `<div class="airport-basic-info">`; // 3rd unclosed <div> element
        html += `<table style="width: 100%; border-collapse: collapse; margin-top: 5px;">`;
        html += `<tr class="airport-subarea"><td colspan="3" class="airport-subarea">Field Information</td></tr>`;
        html += `<tr style="border-bottom: 1px solid #ddd;">`;
        html += `<td colspan="1"  style="text-align: left; padding: 2px 10px 2px 0; vertical-align: top;">IDENTIFIER:</td>`;
        html += `<td colspan="2" style="text-align: left; padding: 2px 0; vertical-align: top;"><b>${ident}</b></td>`;
        html += `</tr>`;
        html += `<tr style="border-bottom: 1px solid #ddd;">`;
        html += `<td colspan="1" style="text-align: left; padding: 2px 10px 2px 0; vertical-align: top;">TYPE:</td>`;
        html += `<td colspan="2" style="text-align: left; padding: 2px 0; vertical-align: top;"><b>${aptype}</b></td>`;
        html += `</tr>`;
        if (airport.elevation) {
            html += `<tr style="border-bottom: 1px solid #ddd;">`;
            html += `<td colspan="1" style="text-align: left; padding: 2px 0; vertical-align: top;">ELEVATION:</td>`;
            html += `<td colspan="2" style="text-align: left; padding: 2px 0; vertical-align: top;"><b>${airport.elevation} ft MSL</b></td>`;
            html += `</tr>`;
        }
        html += `<tr><td colspan="3" style="height: 12px;"></td></tr>`; // end of airport info

        html += `${frhtml}${rwhtml}`;
        html += `</table>`;
        html += `</div></div>`; // closes 2 opened <div> elements
        html += `<div class="popup-button-row" style="display: flex; flex-direction: row; justify-content: space-between; width: 100%;">`;
        if (parameters.hascallback) {
            html += `<button class="custom-popup-button" id="go-back" style="background:${bgcolor}; color:${fgcolor};">Back to ${callertype}</button>`;
        }
        html += `<button class="custom-popup-button" onclick="closePopup()" style="background:${bgcolor}; color:${fgcolor};">Close</button>`;
        html += `</div>`; // closes button-popup-row 

        popupcontent.innerHTML = html;

        // Bind the click event immediately inside the same function scope
        if (parameters.hascallback) {
            const backBtn = popupcontent.querySelector('#go-back');
            if (backBtn) {
                backBtn.addEventListener('click', async () => {
                    await callbackFunction(feature);
                });
            }
        }
    }

    /**
     * Parse forcast fields from metars or tafs
     * @param {string} rawfieldname - the object key before "cleaning" underscores, etc.
     * @param {object} fieldvalue json object corresponding to the key
     * @returns 
     */
    function parseForecastField(rawfieldname, fieldvalue) {
        const rowPrefix = `<tr class="table-row-data">`;
        const cellData = `<td style="width:100%;">`;
        const rowSuffix = `</td></tr>`;
        const skyHeader = `<tr class="skyheader"><td colspan="2" style="display:block;width:99%;text-align:center;border:1px solid #000000;">`;
        const fieldname = tafFieldKeymap.get(rawfieldname);

        let detailhtml = "";
        let formattedValue = "";

        if (fieldname && rawfieldname) {
            let formattedvalue = null;
            switch (rawfieldname) {
                case "fcst_time_from":
                    if (appsettings.uselocaltime) {
                        formattedValue = new Date(fieldvalue).toLocaleString('en-US', { timeZoneName: 'short' });
                    } else {
                        formattedValue = fieldvalue.slice(0, 16).replace('T', ' ') + '&nbspZULU';
                    }
                    detailhtml = `${rowPrefix}${cellData}Time from: ${cellData}<b>${formattedValue}</b>${rowSuffix}`;
                    break;
                case "fcst_time_to": 
                    if (appsettings.uselocaltime) {
                        formattedValue = new Date(fieldvalue).toLocaleString('en-US', { timeZoneName: 'short' });
                    } else {
                        formattedValue = fieldvalue.slice(0, 16).replace('T', ' ') + '&nbspZULU';
                    }
                    detailhtml = `${rowPrefix}${cellData}Time to: ${cellData}<b>${formattedValue}</b>${rowSuffix}`;
                    break;
                case "time_becoming":
                    if (appsettings.uselocaltime) {
                        formattedValue = new Date(fieldvalue).toLocaleString('en-US', { timeZoneName: 'short' });
                    } else {
                        formattedValue = fieldvalue.slice(0, 16).replace('T', ' ') + '&nbspZULU';    
                    }
                    detailhtml = `${rowPrefix}${cellData}Becoming: ${cellData}<b>${formattedValue}</b>${rowSuffix}`;
                    break;
                case "change_indicator":
                    formattedValue = getWeatherAcronymDescription(fieldvalue);
                    if (formattedValue) {
                        detailhtml = `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${formattedValue}</b>${rowSuffix}`;
                    }
                    break;
                case "cloud_base_ft_agl":
                case "cloud_base_ft_msl":
                case "cloud_base":
                case "sky_cover":
                case "visibility_statute_mi":
                    detailhtml = `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${fieldvalue}</b>${rowSuffix}`;
                    break;
                case "change_indicator":
                    formattedValue = getWeatherAcronymDescription(fieldvalue);
                    detailhtml = `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${formattedValue}</b>${rowSuffix}`;
                    break;
                case "sky_cover":
                    detailhtml = `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${fieldvalue}</b>${rowSuffix}`;
                    break;
                case "cloud_base_ft_agl":
                    detailhtml = `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${fieldvalue}</b>${rowSuffix}`;
                    break;
                case "wx_string":
                    formattedvalue = getWeatherAcronymDescription(fieldvalue);
                    detailhtml = `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${formattedvalue}</b>${rowSuffix}`;
                    break;
                case "temperature":
                case "probability":
                case "wind_speed_kt":
                case "wind_gust_kt":
                case "wind_shear_hgt_ft_agl":
                case "wind_shear_speed_kt":
                case "altim_in_hg":
                case "vert_vis_ft":
                    detailhtml = `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${fieldvalue}</b>${rowSuffix}`;
                    break;
                case "sky_condition":
                    detailhtml += `${skyHeader}${fieldname}${rowSuffix}
                                   ${decodeSkyCondition(fieldvalue)}`;
                    break;
                case "turbulence_condition":
                    detailhtml += `${skyHeader}${fieldname}${rowSuffix}
                                   ${decodeIcingOrTurbulenceCondition(fieldvalue)}`;
                    break;
                case "icing_condition":
                    detailhtml += `${skyHeader}${fieldname}${rowSuffix}
                                   ${decodeIcingOrTurbulenceCondition(fieldvalue)}`;
                    break;
                case "wind_dir_degrees":
                case "wind_shear_dir_degrees":
                    formattedvalue = getWeatherAcronymDescription(fieldvalue);
                    if (formattedvalue !== "VARIABLE") {
                        formattedvalue = `${formattedvalue}°`;
                    }
                    detailhtml = `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${formattedvalue}</b>${rowSuffix}`;
                    break;

            }
        }

        if (detailhtml === "") {
            console.log(`Switch case not hit: raw: ${rawfieldname} formatted:${fieldname} value: ${fieldvalue}`);
        }

        return detailhtml;
    }

    /**
     * Decode sky conditions
     * @param {object} json object skyconditions 
     * @param {string} css class to use 
     * @returns html string 
     */
    function decodeSkyCondition(condition) {
        const rowPrefix = `<tr class="table-row-data">`;
        const cellData = `<td style="width:100%;">`;
        const rowSuffix = `</td></tr>`;
        let output = "";
        let fieldname = "";
        let fieldvalue = "";

        //let values = Object.values(condition);
        for (const item in condition) {
            const value = condition[item];
            if (typeof (value) === "object") {
                for (const subitem in value) {
                    const subvalue = getSkyConditionDescription(value[subitem]);
                    fieldname = getFieldDescription(subitem);
                    if (fieldname && subvalue) {
                        output += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${subvalue}</b>${rowSuffix}`;
                    }
                }
            }
            else {
                fieldname = getFieldDescription(item);
                fieldvalue = getSkyConditionDescription(value);
                if (fieldname && fieldvalue) {
                    output += `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${fieldvalue}</b>${rowSuffix}`;
                }
            }
        }
        return output;
    }

    /**
     * Get inches of mercury fixed at 2 decimal places
     * @param {float} altimeter 
     * @returns 
     */
    function getInchesOfMercury(altimeter) {
        let inhg = parseFloat(altimeter);
        return inhg.toFixed(2);
    }

    /**
     * Decode icing or turbulence condition
     * @param {object} condition json object 
     * @returns html string
     */
    function decodeIcingOrTurbulenceCondition(condition) {
        let output = "";
        for (const item in condition) {
            const value = condition[item];
            if (typeof (value) === 'object') {
                for (const subitem in value) {
                    const subvalue = value[subitem];
                    output += parseConditionField(subitem, subvalue);
                }
            }
            else {
                output += parseConditionField(item, value);
            }
        }
        return output;
    }

    /**
     * Parse an icing or turbulence condition field value, 
     * which could be an object or a string and return html
     * @param {string} rawfieldname 
     * @param {object} fieldvalue 
     * @returns html string
     */
    function parseConditionField(rawfieldname, fieldvalue) {
        const rowPrefix = `<tr class="table-row-data">`;
        const cellData = `<td style="width:100%;">`;
        const rowSuffix = `</td></tr>`;
        const fieldname = getFieldDescription(rawfieldname);
        let textvalue = "";

        switch (fieldvalue) {
            case "NEGclr":
                textvalue = "Negative Clear";
                break;
            case "NEG":
                textvalue = "Negative";
                break;
            case "RIME":
                textvalue = "Rime";
                break;
            case "INT":
                textvalue = "Intermittent";
                break;
            case "TRC":
                textvalue = "Trace";
                break;
            case "TRC-LGT":
                textvalue = "Trace to Light";
                break;
            case "LGT":
                textvalue = "Light";
                break;
            case "SMTH-LGT":
                textvalue = "Smooth to Light";
                break;
            case "LGT-MOD":
                textvalue = "Light to Moderate";
                break;
            case "MOD":
                textvalue = "Moderate";
                break;
            case "LGT-CHOP":
                textvalue = "Light to Chop";
                break;
            case "CHOP":
                textvalue = "Chop";
                break;
            case "MOD-CHOP":
                textvalue = "Moderate to Chop";
                break;
            case "MOD-SEV":
                textvalue = "Moderate to Severe";
                break;
            case "SEV":
                textvalue = "Severe";
                break;
            case "OCNL":
                textvalue = "Occasional";
                break;
            default:
                textvalue = fieldvalue;
                break;
        }
        return `${rowPrefix}${cellData}${fieldname}: ${cellData}<b>${textvalue.toUpperCase()}</b>${rowSuffix}`;
    }

    /**
     * Place metar features on the map. color-coded to the conditions
     * @param {object} metar object: JSON object with metar data
     */
    async function processMetar(metarObject) {
        // await the incoming metar...
        const metar = await metarObject;

        // Validate required properties
        if (!metar || typeof metar.longitude !== 'number' || typeof metar.latitude !== 'number') {
            return;
        }

        try {

            var popupSvg = "";
            var mapDotSvg = "";
            try {
                popupSvg = rawWeatherTextToSVG(metar, 150, 150);
                mapDotSvg = getWindBarbSvg(125, 125, metar);
            }
            catch { }

            const metarmarker = new Icon({
                crossOrigin: 'anonymous',
                src: `data:image/svg+xml;utf8,${encodeURIComponent(mapDotSvg)}`,
                offset: [0, 0],
                opacity: 1,
                scale: getScaleSize()
            });

            const metarFeature = new Feature({
                ident: metar.station_id,
                id: metar.station_id,
                data: metar,
                datatype: "METAR",
                geometry: new Point(fromLonLat([metar.longitude, metar.latitude])),
                svgimage: popupSvg
            });

            metarFeature.setStyle(new Style({
                image: metarmarker
            }));

            metarVectorLayer.getSource().addFeature(metarFeature);
            metarFeature.changed();
            metarVectorLayer.changed();
        }
        catch (error) {
            console.log(error.message);
        }
    }

    /**
     * Place taf feature objects on the map
     * @param {object} taf: JSON object
     */
    async function processTaf(tafObject) {
        // await the incoming Promise
        const taf = await tafObject;

        // Validate required properties
        if (!taf || typeof taf.longitude !== 'number' || typeof taf.latitude !== 'number') {
            return;
        }
        const rawText = taf.raw_text;
        const fc = await getCurrentTafFlightCategoryColors(rawText);
        const bgcolor = fc.bgcolor;
        const fgcolor = fc.fgcolor;
        const category = fc.category;

        const svgimg = `<svg xmlns="http://www.w3.org/2000/svg" width="157.5" height="112.5" viewBox="0 0 33.526 23.62">
        <g transform="translate(-.143 -.036)">
        <path d="M32.995 11.846A16.095 11.149 0 0 1 16.96 22.995 16.095 11.149 0 0 1 .805 11.928 16.095 11.149 0 0 1 16.72.698a16.095 11.149 0 0 1 16.272 10.983l-16.093.165z" 
        style="fill:${bgcolor};fill-opacity:1;stroke:#000;stroke-width:1.32292;stroke-miterlimit:4;stroke-dasharray:none;stroke-opacity:1"/>
        <rect width="17.563" height="1.608" x="14.711" y="10.95" ry=".023" style="fill:${bgcolor};fill-opacity:1;stroke:none;stroke-width:2.44876;stroke-miterlimit:4;stroke-dasharray:none;stroke-opacity:1"/>
        <text xml:space="preserve" x="4.995" y="17.051" style="font-style:normal;font-variant:normal;
        font-weight:700;font-stretch:normal;font-size:14.2894px;line-height:1.25;font-family:sans-serif;
        -inkscape-font-specification:&quot;sans-serif, Bold&quot;;font-variant-ligatures:normal;
        font-variant-caps:normal;font-variant-numeric:normal;font-variant-east-asian:normal;letter-spacing:0;
        word-spacing:0;fill:#ff0;fill-opacity:1;stroke:none;stroke-width:.357233" transform="scale(.9667 1.03444)">
        <tspan x="4.995" y="17.051" style="font-style:normal;font-variant:normal;font-weight:700;font-stretch:normal;
        font-size:14.2894px;font-family:sans-serif;-inkscape-font-specification:&quot;sans-serif, Bold&quot;;font-variant-ligatures:normal;
        font-variant-caps:normal;font-variant-numeric:normal;font-variant-east-asian:normal;fill:${fgcolor};
        fill-opacity:1;stroke-width:.357233">TAF</tspan></text></g></svg>`

        try {
            const tafFeature = new Feature({
                ident: taf.station_id,
                id: taf.station_id,
                data: taf,
                bgcolor: bgcolor,
                fgcolor: fgcolor,
                category: category,
                datatype: "TAF",
                geometry: new Point(fromLonLat([taf.longitude, taf.latitude]))
            });
            tafFeature.setStyle(new Style({
                image: new Icon({
                    crossOrigin: 'anonymous',
                    src: `data:image/svg+xml;utf8,${encodeURIComponent(svgimg)}`,
                    offset: [0, 0],
                    opacity: 1,
                    size: [157.5, 112.5],
                    scale: .2
                })
            }));

            tafVectorLayer.getSource().addFeature(tafFeature)
            tafFeature.changed();
            tafVectorLayer.changed();
        }
        catch (error) {
            console.log(error.message);
        }
    }

    /**
     * module-scope common pirep IconStyle for later manipulation
     */
    const pirepsvg = `<svg xmlns="http://www.w3.org/2000/svg" version="1.0" width="650" height="700"><path d="m293.301 160.266.23 66.375-69.156 56.187V255.86h-23.094v46.532l-70.796 59.528-108.11 92.41-7.781 35.78 191.375-104.25 87.125-23.343 1.562 154.03 17.094 73.126-90.906 68.625v29.406l104.312-22.156 104 22.094v-29.407L338.25 589.61l17.094-73.125 1.562-154.03 87.125 23.343 191.375 104.25-7.781-35.781-107.164-91.403-71.742-60.535v-46.531h-23.094v26.969l-70.933-56.188.007-66.375c0-27.014.991-111.224-29.418-147.906-29.396 41.87-30.385 96.99-31.98 147.969z" style="opacity:1;color:#000;fill:#98294c;fill-opacity:1;fill-rule:nonzero;stroke:#000;stroke-width:4;stroke-linecap:round;stroke-linejoin:miter;marker:none;marker-start:none;marker-mid:none;marker-end:none;stroke-miterlimit:4;stroke-dasharray:none;stroke-dashoffset:0;stroke-opacity:1;visibility:visible;display:inline;overflow:visible"/></svg>`;
    const pirepIconStyle = new Style({
        image: new Icon({
            crossOrigin: 'anonymous',
            src: `data:image/svg+xml;utf8,${encodeURIComponent(pirepsvg)}`,
            offset: [0, 0],
            opacity: 1,
            scale: .05,
            rotation: 0
        })
    });
    /**
     * Place pirep features on the map
     * @param {object} pirep: JSON object with LOTS of pireps 
     */
    async function processPirep(pirepObject) {
        // await the pirepPromise
        const pirep = await pirepObject;

        const pseudoHeadingRadians = (lat, lon) => {
            const absLat = Math.abs(lat);
            let baseHeading;
            let varianceRange;

            if (absLat <= 30) {
                // Equatorial / Subtropical bands: Easterly flow
                baseHeading = 90;
                varianceRange = 20;
            } else {
                // Mid-latitudes and Polar bands (both North & South): Westerly flow
                baseHeading = 270;
                varianceRange = 30;
            }

            // Use longitude to create a smooth, natural wave pattern variance (-15° to +15°)
            const radLon = lon * (Math.PI / 180);
            const waveVariance = Math.sin(radLon * 2) * (varianceRange / 2);
            const degrees = Math.floor((baseHeading + waveVariance + 360) % 360);

            // Final heading normalized within 0-359 degrees, in radians
            return degrees * 0.0174533;
        };

        // Validate required properties
        if (!pirep || typeof pirep.longitude !== 'number' || typeof pirep.latitude !== 'number') {
            return;
        }
        try {
            // if there is already a report from this aircraft, remove it before adding a new one
            const id = pirep.aircraft_ref ? pirep.aircraft_ref : pirep.station_id;
            const existingFeature = pirepVectorSource.getFeatureById(id);
            if (existingFeature) {
                pirepVectorSource.removeFeature(existingFeature);
            }
            const pirepFeature = new Feature({
                ident: id,
                id: id,
                data: pirep,
                datatype: "PIREP",
                geometry: new Point(fromLonLat([pirep.longitude, pirep.latitude])),
                zIndex: 4800
            });
            pirepFeature.setId(id);
            pirepFeature.setStyle(pirepIconStyle);
            pirepVectorSource.addFeature(pirepFeature);
            pirepVectorSource.changed();
        }
        catch (err) {
            console.error(`Error in processPirep: ${err}`);
        }
    }

    /**
     * This routine adjusts feature "dot" image 
     * sizes, depending on current zoom level
     */
    let resizing = false;
    function resizeDots(newzoom) {
        if (!resizing) {
            resizing = true;
            currentZoom = parseInt(newzoom.toFixed(0));
            let newscale = getScaleSize();
            let features = {};
            features = metarVectorLayer.getSource().getFeatures();
            for (let i = 0; i < features.length; i++) {
                let style = features[i].getStyle();
                if (style && style.getImage()) {
                    style.getImage().setScale(newscale);
                    features[i].setStyle(style); // update the feature's style
                }
            }
            features = tafVectorLayer.getSource().getFeatures();
            for (let i = 0; i < features.length; i++) {
                let style = features[i].getStyle();
                if (style && style.getImage()) {
                    style.getImage().setScale(newscale * .20);
                    features[i].setStyle(style); // update the feature's style
                }
            }
            features = pirepVectorLayer.getSource().getFeatures();
            for (let i = 0; i < features.length; i++) {
                let style = features[i].getStyle();
                if (style && style.getImage()) {
                    style.getImage().setScale(newscale * .12);
                    features[i].setStyle(style); // update the feature's style
                }
            }
            features = airportVectorLayer.getSource().getFeatures();
            for (let i = 0; i < features.length; i++) {
                let style = features[i].getStyle();
                if (style && style.getImage()) {
                    style.getImage().setScale(newscale);
                    features[i].setStyle(style); // update the feature's style
                }
            }
            resizing = false;
        }
    }

    function getScaleSize() {
        let scale = 1;
        switch (true) {
            case currentZoom >= 0 && currentZoom < 1:
                scale = .05;
                break;
            case currentZoom >= 1 && currentZoom < 2:
                scale = .075;
                break;
            case currentZoom >= 2 && currentZoom < 3:
                scale = .10;
                break;
            case currentZoom >= 3 && currentZoom < 4:
                scale = .15;
                break;
            case currentZoom >= 4 && currentZoom < 5:
                scale = .275;
                break;
            case currentZoom >= 5 && currentZoom < 6:
                scale = .40;
                break;
            case currentZoom >= 6 && currentZoom < 7:
                scale = .60;
                break;
            case currentZoom >= 7 && currentZoom < 8:
                scale = .80;
                break;
            case currentZoom >= 8 && currentZoom < 9:
                scale = 1;
                break;
            case currentZoom >= 9 && currentZoom < 10:
                scale = 1.2;
                break;
            case currentZoom >= 10 && currentZoom < 11:
                scale = 1.4;
                break;
            case currentZoom >= 11:
                scale = 1.6;
                break;
        }
        return scale;
    }

    // Airport-specific scaling function that maintains readability at all zoom levels
    function getAirportScaleSize() {
        let scale = 1;
        switch (true) {
            case currentZoom >= 0 && currentZoom < 2:
                scale = 0.8;  // Larger at very far zoom
                break;
            case currentZoom >= 2 && currentZoom < 4:
                scale = 1.0;  // Standard size at far zoom
                break;
            case currentZoom >= 4 && currentZoom < 6:
                scale = 1.2;  // Slightly larger at medium zoom
                break;
            case currentZoom >= 6 && currentZoom < 8:
                scale = 1.4;  // Larger at closer zoom
                break;
            case currentZoom >= 8 && currentZoom < 10:
                scale = 1.6;  // Even larger when zoomed in
                break;
            case currentZoom >= 10:
                scale = 1.8;  // Largest when very zoomed in
                break;
        }
        return scale;
    }

    // /**
    //  * This allows a clicked feature to raise an event
    //  */
    // let select = null;
    // function selectStyle(feature) {
    //     console.log(`FEATURE: ${feature}`);
    //     return selected;
    // }

    /**
     * Convert statute miles to desired unit 
     * @param {*} miles: statute miles
     * @returns statute miles, kilometers or nautical miles   
     */
    function getDistanceUnits(miles) {
        let num = parseFloat(miles);
        let label = "mi";
        switch (distanceunit) {
            case DistanceUnits.kilometers:
                num = miles * 1.609344;
                label = "km"
                break;
            case DistanceUnits.nauticalmiles:
                num = miles * 0.8689762419;
                label = "nm";
                break;
        }
        return `${num.toFixed(1)} ${label}`;
    }

    /**
     * 
     * @param {*} temp: Temperature in Centigrade 
     * @returns Farenheit temperature fixed to 2 decimal places
     */
    const convertCtoF = ((temp) => {
        if (temp == undefined) return "";
        let num = (temp * 9 / 5 + 32);
        if (num === NaN || num === undefined) return "";
        else return `${num.toFixed(1)} F°`;
    });

    /**
     * Utility function to replace all instances of a  
     * specified string with another specified string
     * @param {*} string: string to search 
     * @param {*} search: string to search FOR 
     * @param {*} replace: string to replace any found search 
     * @returns sring: the new string with replacements
     */
    function replaceAll(string, search, replace) {
        return string.split(search).join(replace);
    }

    /**
     * This just makes a zulu date look nicer...
     * @param {*} zuludate 
     * @returns string: cleaned zulu date
     */
    function formatZuluDate(zuludate) {
        let workstring = zuludate.split("T");
        let zstring = workstring[1].slice(0, -1);
        return `${workstring[0]} ${zstring} Z`;
    }

    /**
     * Get the local machine date/time from the supplied ZULU date
     * @param {*} zuludate: the ZULU date to be translated 
     * @returns string: the translated date in standard or daylight time
     */
    function getLocalTime(zuludate) {
        let date = new Date(zuludate);
        let hours = date.getHours();
        let minutes = date.getMinutes();
        let ampm = hours >= 12 ? 'PM' : 'AM';
        let month = date.getMonth() + 1;
        let day = date.getDate();
        let year = date.getFullYear();
        let tzone = "";

        hours = hours % 12;
        hours = hours ? hours : 12; // the hour '0' should be '12'
        minutes = minutes < 10 ? '0' + minutes : minutes;

        let timex = date.toString().split("GMT");
        let time = timex[1];

        if (time.search("Eastern Standard") > -1) {
            tzone = "EST";
        }
        if (time.search("Eastern Daylignt") > -1) {
            tzone = "EDT";
        }
        if (time.search("Central Standard") > -1) {
            tzone = "CST";
        }
        if (time.search("Central Daylight") > -1) {
            tzone = "CDT";
        }
        if (time.search("Mountain Standard") > -1) {
            tzone = "MST";
        }
        if (time.search("Mountain Daylight") > -1) {
            tzone = "MDT";
        }
        if (time.search("Pacific Standard") > -1) {
            tzone = "PST";
        }
        if (time.search("Pacific Daylight") > -1) {
            tzone = "PDT";
        }
        if (time.search("Alaska Standard") > -1) {
            tzone = "AKST";
        }
        if (time.search("Alaska Daylight") > -1) {
            tzone = "AKDT";
        }
        if (time.search("Atlantic Standard") > -1) {
            tzone = "AST";
        }
        if (time.search("Atlantic Daylight") > -1) {
            tzone = "ADT";
        }
        return `${month}-${day}-${year} ${hours}:${minutes} ${ampm} ${tzone}`;
    }

    /**
     * Utility function to trim and round Metar or TAF  
     * altimeter value to a standard fixed(2) number
     * @param {*} altimeter 
     * @returns 
     */
    function getAltimeterSetting(altimeter) {
        let dbl = parseFloat(altimeter);
        return dbl.toFixed(2).toString();
    }

    /**
     * Get the formatted name of an airport
     * @param {string} ident, the airport identifier 
     * @returns string, formatted name of the airport
     */
    function getFormattedAirportName(ident) {
        let retvalue = airportNameKeymap.get(ident);
        if (retvalue === undefined ||
            retvalue === "undefined" ||
            retvalue === "") {
            retvalue = "";
        }
        else {
            retvalue = retvalue.replace("/", "\n");
            retvalue = retvalue.replace(",", "\n");
        }
        return retvalue;
    }

    /**
     * Get the description for a TAF fieldname abbreviation
     * @param {string} fieldname 
     * @returns string, readable description of fieldname 
     */
    function getFieldDescription(fieldname) {
        if (!Number.isInteger(fieldname)) {
            const testval = tafFieldKeymap.get(fieldname);
            if (testval !== undefined && testval !== "") {
                return testval;
            }
        }
        return fieldname;
    }

    /**
     * Load normalized TAF field names
     */
    function loadTafFieldKeymap() {
        tafFieldKeymap.set("temp_c", "Temperature °C");
        tafFieldKeymap.set("icing_type", "Icing Type");
        tafFieldKeymap.set("pirep_type", "Pirep Type");
        tafFieldKeymap.set("altitude_ft_msl", "Altitude");
        tafFieldKeymap.set("receipt_time", "Receipt Time")
        tafFieldKeymap.set("observation_time", "Observation Time")
        tafFieldKeymap.set("latitude", "Latitude")
        tafFieldKeymap.set("longitude", "Longitude")
        tafFieldKeymap.set("cloud_type", "Cloud Type");
        tafFieldKeymap.set("fcst_time_from", "Time From");
        tafFieldKeymap.set("fcst_time_to", "Time To");
        tafFieldKeymap.set("change_indicator", "Change Indicator");
        tafFieldKeymap.set("time_becoming", "Time Becoming");
        tafFieldKeymap.set("probability", "Probability");
        tafFieldKeymap.set("wind_dir_degrees", "Wind Direction");
        tafFieldKeymap.set("wind_speed_kt", "Wind Speed");
        tafFieldKeymap.set("wind_gust_kt", "Wind Gust knots");
        tafFieldKeymap.set("wind_shear_hgt_ft_agl", "Shear Height");
        tafFieldKeymap.set("wind_shear_dir_degrees", "Shear Direction");
        tafFieldKeymap.set("wind_shear_speed_kt", "Shear Speed");
        tafFieldKeymap.set("altim_in_hg", "Altimeter (Hg)");
        tafFieldKeymap.set("vert_vis_ft", "Vert. Visibility");
        tafFieldKeymap.set("visibility_statute_mi", "Horiz. Visibility");
        tafFieldKeymap.set("wx_string", "Weather");
        tafFieldKeymap.set("sky_condition", "Sky Condition");
        tafFieldKeymap.set("icing_condition", "Icing Condition");
        tafFieldKeymap.set("turbulence_condition", "Turbulence Condition");
        tafFieldKeymap.set("sky_cover", "Sky Cover");
        tafFieldKeymap.set("cloud_base_ft_agl", "Cloud Base");
        tafFieldKeymap.set("cloud_base_ft_msl", "Cloud Base");
        tafFieldKeymap.set("cloud_base", "Cloud Base");
        // icing fieldnames
        tafFieldKeymap.set("icing_intensity", "Intensity");
        tafFieldKeymap.set("icing_min_alt_ft_agl", "Min Altitude");
        tafFieldKeymap.set("icing_max_alt_ft_agl", "Max Altitude");
        tafFieldKeymap.set("icing_min_alt_ft_msl", "Min Altitude");
        tafFieldKeymap.set("icing_max_alt_ft_agl", "Max Altitude ");
        tafFieldKeymap.set("icing_type", "Type");
        tafFieldKeymap.set("icing_top_ft_msl", "Top");
        tafFieldKeymap.set("icing_base_ft_msl", "Base");
        // turbulence fieldnames
        tafFieldKeymap.set("turbulence_intensity", "Intensity");
        tafFieldKeymap.set("turbulence_min_alt_ft_agl", "Min Altitude");
        tafFieldKeymap.set("turbulence_max_alt_ft_agl", "Max Altitude ");
        tafFieldKeymap.set("turbulence_freq", "Frequency");
        tafFieldKeymap.set("turbulence_type", "Turbulence Type");
        tafFieldKeymap.set("turbulence_top_ft_msl", "Top");
        tafFieldKeymap.set("turbulence_base_ft_msl", "Base");
        tafFieldKeymap.set("LLWS", "Low Level Wind Shear");
    }

    /**
     * Get the description for a TAF/Metar fieldname abbreviation
     * @param {string} fieldname 
     * @returns string, readable description of fieldname 
     */
    function getMetarFieldDescription(fieldname) {
        let retvalue = metarFieldKeymap.get(fieldname);
        if (retvalue === undefined || retvalue === "") {
            retvalue = replaceAll(fieldname, "_", " ");
        }
        return retvalue;
    }
    /**
     * Load normalized metar field names
     */
    function loadMetarFieldKeymap() {
        metarFieldKeymap.set("change_indicator", "Change indicator");
        metarFieldKeymap.set("raw_text", "raw text");
        metarFieldKeymap.set("station_id", "station id");
        metarFieldKeymap.set("observation_time", "Observation Time");
        metarFieldKeymap.set("latitude", "latitude");
        metarFieldKeymap.set("longitude", "longitude");
        metarFieldKeymap.set("temp_c", "Temp °C");
        metarFieldKeymap.set("dewpoint_c", "Dewpoint °C");
        metarFieldKeymap.set("wind_dir_degrees", "Wind direction");
        metarFieldKeymap.set("wind_speed_kt", "Wind speed knots");
        metarFieldKeymap.set("wind_gust_kt", "Wind gust knots");
        metarFieldKeymap.set("visibility_statute_mi", "Horizontal visibility in statute miles");
        metarFieldKeymap.set("altim_in_hg", "Altimeter in Hg");
        metarFieldKeymap.set("sea_level_pressure_mb", "Sea-level pressure in MB");
        metarFieldKeymap.set("quality_control_flags", "Quality control flags");
        metarFieldKeymap.set("wx_string", "Weather");
        metarFieldKeymap.set("sky_condition", "Sky cover");
        metarFieldKeymap.set("sky_cover", "Sky cover");
        metarFieldKeymap.set("cloud_base_ft_agl", "Cloud base feet AGL");
        metarFieldKeymap.set("cloud_base", "Cloud base");
        metarFieldKeymap.set("flight_category", "Flight category");
        metarFieldKeymap.set("three_hr_pressure_tendency_mb", "Pressure change past 3 hours in MB");
        metarFieldKeymap.set("maxT_c", "Max air temp °C, past 6 hours");
        metarFieldKeymap.set("minT_c", "Min air temp °C, past 6 hours");
        metarFieldKeymap.set("maxT24hr_c", "Max air temp °C, past 24 hours");
        metarFieldKeymap.set("minT24hr_c", "Min air temp °C, past 24 hours");
        metarFieldKeymap.set("precip_in", "Liquid precipitation since last METAR");
        metarFieldKeymap.set("pcp3hr_in", "Liquid precipitation past 3 hours");
        metarFieldKeymap.set("pcp6hr_in", "Liquid precipitation past 6 hours");
        metarFieldKeymap.set("pcp24hr_in", "Liquid precipitation past 24 hours");
        metarFieldKeymap.set("snow_in", "Snow depth in inches");
        metarFieldKeymap.set("vert_vis_ft", "Vertical visibility in feet");
        metarFieldKeymap.set("metar_type", "Metar type");
        metarFieldKeymap.set("elevation_m", "Station elevation in meters");
    }

    /**
     * Get the description for a TAF/Metar weather acronym
     * @param {string} acronym 
     * @returns string, readable description of acronym 
     */
    function getWeatherAcronymDescription(acronym) {
        let retvalue = weatherAcronymKeymap.get(acronym);
        if (retvalue === undefined) retvalue = acronym;
        return String(retvalue).toUpperCase();
    }
    /**
     * Load the wxkeymap Map object with weather code descriptions
     */
    function loadWeatherAcronymKeymap() {
        weatherAcronymKeymap.set("FM", "From");
        weatherAcronymKeymap.set("CLR", "Clear");
        weatherAcronymKeymap.set("SCT", "Scattered");
        weatherAcronymKeymap.set("BKN", "Broken");
        weatherAcronymKeymap.set("OVC", "Overcast");
        weatherAcronymKeymap.set("OCNL", "Occasional");
        weatherAcronymKeymap.set("TEMPO", "Temporary");
        weatherAcronymKeymap.set("BECMG", "Becoming");
        weatherAcronymKeymap.set("PROB", "Probability");
        weatherAcronymKeymap.set("FU", "Smoke");
        weatherAcronymKeymap.set("VA", "Volcanic Ash");
        weatherAcronymKeymap.set("HZ", "Haze");
        weatherAcronymKeymap.set("DU", "Dust");
        weatherAcronymKeymap.set("SA", "Sand");
        weatherAcronymKeymap.set("BLDU", "Blowing dust");
        weatherAcronymKeymap.set("BLSA", "Blowing sand");
        weatherAcronymKeymap.set("PO", "Dust devil");
        weatherAcronymKeymap.set("VCSS", "Vicinity sand storm");
        weatherAcronymKeymap.set("BR", "Mist or light fog");
        weatherAcronymKeymap.set("MIFG", "More or less continuous shallow fog");
        weatherAcronymKeymap.set("VCTS", "Vicinity thunderstorm");
        weatherAcronymKeymap.set("VIRGA", "Virga or precipitation not hitting ground");
        weatherAcronymKeymap.set("VCSH", "Vicinity showers");
        weatherAcronymKeymap.set("TS", "Thunderstorm with or without precipitation");
        weatherAcronymKeymap.set("SQ", "Squalls");
        weatherAcronymKeymap.set("FC", "Funnel cloud or tornado");
        weatherAcronymKeymap.set("SS", "Sand or dust storm");
        weatherAcronymKeymap.set("+SS", "Strong sand or dust storm");
        weatherAcronymKeymap.set("BLSN", "Blowing snow");
        weatherAcronymKeymap.set("DRSN", "Drifting snow");
        weatherAcronymKeymap.set("VCFG", "Vicinity fog");
        weatherAcronymKeymap.set("BCFG", "Patchy fog");
        weatherAcronymKeymap.set("PRFG", "Fog, sky discernable");
        weatherAcronymKeymap.set("FG", "Fog, sky undiscernable");
        weatherAcronymKeymap.set("FZFG", "Freezing fog");
        weatherAcronymKeymap.set("-DZ", "Light drizzle");
        weatherAcronymKeymap.set("DZ", "Moderate drizzle");
        weatherAcronymKeymap.set("+DZ", "Heavy drizzle");
        weatherAcronymKeymap.set("-FZDZ", "Light freezing drizzle");
        weatherAcronymKeymap.set("FZDZ", "Moderate freezing drizzle");
        weatherAcronymKeymap.set("+FZDZ", "Heavy freezing drizzle");
        weatherAcronymKeymap.set("-DZRA", "Light drizzle and rain");
        weatherAcronymKeymap.set("DZRA", "Moderate to heavy drizzle and rain");
        weatherAcronymKeymap.set("-RA", "Light rain");
        weatherAcronymKeymap.set("RA", "Moderate rain");
        weatherAcronymKeymap.set("+RA", "Heavy rain");
        weatherAcronymKeymap.set("-FZRA", "Light freezing rain");
        weatherAcronymKeymap.set("FZRA", "Moderate freezing rain");
        weatherAcronymKeymap.set("+FZRA", "Heavy freezing rain");
        weatherAcronymKeymap.set("-RASN", "Light rain and snow");
        weatherAcronymKeymap.set("RASN", "Moderate rain and snow");
        weatherAcronymKeymap.set("+RASN", "Heavy rain and snow");
        weatherAcronymKeymap.set("-SN", "Light snow");
        weatherAcronymKeymap.set("SN", "Moderate snow");
        weatherAcronymKeymap.set("+SN", "Heavy snow");
        weatherAcronymKeymap.set("SG", "Snow grains");
        weatherAcronymKeymap.set("IC", "Ice crystals");
        weatherAcronymKeymap.set("PE PL", "Ice pellets");
        weatherAcronymKeymap.set("PE", "Ice pellets");
        weatherAcronymKeymap.set("PL", "Ice pellets");
        weatherAcronymKeymap.set("-SHRA", "Light rain showers");
        weatherAcronymKeymap.set("SHRA", "Moderate rain showers");
        weatherAcronymKeymap.set("+SHRA", "Heavy rain showers");
        weatherAcronymKeymap.set("-SHRASN", "Light rain and snow showers");
        weatherAcronymKeymap.set("SHRASN", "Moderate rain and snow showers");
        weatherAcronymKeymap.set("+SHRASN", "Heavy rain and snow showers");
        weatherAcronymKeymap.set("-SHSN", "Light snow showers");
        weatherAcronymKeymap.set("SHSN", "Moderate snow showers");
        weatherAcronymKeymap.set("+SHSN", "Heavy snow showers");
        weatherAcronymKeymap.set("-GR", "Light showers with hail, not with thunder");
        weatherAcronymKeymap.set("GR", "Moderate to heavy showers with hail, not with thunder");
        weatherAcronymKeymap.set("TSRA", "Light to moderate thunderstorm with rain");
        weatherAcronymKeymap.set("TSGR", "Light to moderate thunderstorm with hail");
        weatherAcronymKeymap.set("+TSRA", "Thunderstorm with heavy rain");
        weatherAcronymKeymap.set("UP", "Unknown precipitation");
        weatherAcronymKeymap.set("NSW", "No significant weather");
        weatherAcronymKeymap.set("VRB", "Variable");
    }

    /**
     * Get the description for a sky condition acronym
     * @param {string} acronym 
     * @returns acronym if found, otherwise just returns key
     */
    function getSkyConditionDescription(acronym) {
        let retvalue = skyConditionKeymap.get(acronym);
        if (retvalue === undefined || retvalue === null) {
            return acronym;
        }
        return String(retvalue).toUpperCase();
    }
    /**
     * Map containing standard TAF/Metar acronyms
     */
    function loadSkyConditionmKeymap() {
        skyConditionKeymap.set("BKN", "Broken");
        skyConditionKeymap.set("CLR", "Clear");
        skyConditionKeymap.set("SCT", "Scattered");
        skyConditionKeymap.set("FM", "From");
        skyConditionKeymap.set("TEMPO", "Temporary");
        skyConditionKeymap.set("BECMG", "Becoming");
        skyConditionKeymap.set("PROB", "Probability");
        skyConditionKeymap.set("CB", "Cumulo-Nimbus");
        skyConditionKeymap.set("IMC", "Instrument meteorological conditions"),
        skyConditionKeymap.set("IMPR", "Improving");
        skyConditionKeymap.set("INC", "In Clouds");
        skyConditionKeymap.set("INS", "Inches");
        skyConditionKeymap.set("INTER", "Intermittent");
        skyConditionKeymap.set("INTSF", "Intensify(ing)");
        skyConditionKeymap.set("INTST", "Intensity");
        skyConditionKeymap.set("JTST", "Jet stream");
        skyConditionKeymap.set("KM", "Kilometers");
        skyConditionKeymap.set("KMH", "Kilometers per hour");
        skyConditionKeymap.set("KT", "Knots");
        skyConditionKeymap.set("L", "Low pressure area");
        skyConditionKeymap.set("LAN", "Land");
        skyConditionKeymap.set("LDA", "Landing distance available");
        skyConditionKeymap.set("LDG", "Landing");
        skyConditionKeymap.set("LGT", "Light");
        skyConditionKeymap.set("LOC", "Locally");
        skyConditionKeymap.set("LSQ", "Line squall");
        skyConditionKeymap.set("LSR", "Loose snow on runway");
        skyConditionKeymap.set("LTG", "Lightning");
        skyConditionKeymap.set("LYR", "Layer");
        skyConditionKeymap.set("M", "Meters");
        skyConditionKeymap.set("M", "Minus or below zero");
        skyConditionKeymap.set("M", "Less than lowest reportable sensor value");
        skyConditionKeymap.set("MAX", "Maximum");
        skyConditionKeymap.set("MB", "Millibars");
        skyConditionKeymap.set("MET", "Meteorological");
        skyConditionKeymap.set("MI", "Shallow");
        skyConditionKeymap.set("MIN", "Minutes");
        skyConditionKeymap.set("MNM", "Minimum");
        skyConditionKeymap.set("MOD", "Moderate");
        skyConditionKeymap.set("MOV", "Move, moving");
        skyConditionKeymap.set("MPS", "Meters per second");
        skyConditionKeymap.set("MS", "Minus");
        skyConditionKeymap.set("MSL", "Mean sea level");
        skyConditionKeymap.set("MTW", "Mountain waves");
        skyConditionKeymap.set("MU", "Runway friction coefficent");
        skyConditionKeymap.set("NC", "No change");
        skyConditionKeymap.set("NIL", "None, nothing");
        skyConditionKeymap.set("NM", "Nautical mile(s)");
        skyConditionKeymap.set("NMRS", "Numerous");
        skyConditionKeymap.set("NO", "Not available");
        skyConditionKeymap.set("NOSIG", "No significant change");
        skyConditionKeymap.set("NS", "Nimbostratus");
        skyConditionKeymap.set("NSC", "No significant clouds");
        skyConditionKeymap.set("NSW", "No Significant Weather");
        skyConditionKeymap.set("OBS", "Observation");
        skyConditionKeymap.set("OBSC", "Obscuring");
        skyConditionKeymap.set("OCNL", "Occasional");
        skyConditionKeymap.set("OKTA", "Eight of sky cover");
        skyConditionKeymap.set("OTP", "On top");
        skyConditionKeymap.set("OTS", "Out of service");
        skyConditionKeymap.set("OVC", "Overcast");
        skyConditionKeymap.set("P", "Greater than highest reportable sensor value");
        skyConditionKeymap.set("P6SM", "Visibility greater than 6 SM");
        skyConditionKeymap.set("PAEW", "Personnel and equipment working");
        skyConditionKeymap.set("PE", "Ice Pellets");
        skyConditionKeymap.set("PJE", "Parachute Jumping Exercise");
        skyConditionKeymap.set("PK WND", "Peak wind");
        skyConditionKeymap.set("PLW", "Plow/plowed");
        skyConditionKeymap.set("PNO", "Precipitation amount not available");
        skyConditionKeymap.set("PO", "Dust/Sand Whirls");
        skyConditionKeymap.set("PPR", "Prior permission required");
        skyConditionKeymap.set("PR", "Partial");
        skyConditionKeymap.set("PRESFR", "Pressure falling rapidly");
        skyConditionKeymap.set("PRESRR", "Pressure rising rapidly");
        skyConditionKeymap.set("PROB", "Probability");
        skyConditionKeymap.set("PROB30", "Probability 30 percent");
        skyConditionKeymap.set("PS", "Plus");
        skyConditionKeymap.set("PSR", "Packed snow on runway");
        skyConditionKeymap.set("PWINO", "Precipitation id sensor not available");
        skyConditionKeymap.set("PY", "Spray");
        skyConditionKeymap.set("R", "Runway (in RVR measurement)");
        skyConditionKeymap.set("RA", "Rain");
        skyConditionKeymap.set("RAB", "Rain Began");
        skyConditionKeymap.set("RADAT", "Radiosonde observation addl data");
        skyConditionKeymap.set("RAE", "Rain Ended");
        skyConditionKeymap.set("RAPID", "Rapid(ly)");
        skyConditionKeymap.set("RASN", "Rain and snow");
        skyConditionKeymap.set("RCAG", "Remote Center Air/Ground Comm Facility");
        skyConditionKeymap.set("RMK", "Remark");
        skyConditionKeymap.set("RVR", "Runway visual range");
        skyConditionKeymap.set("RVRNO", "RVR not available");
        skyConditionKeymap.set("RY/RWY", "Runway");
        skyConditionKeymap.set("SA", "Sand");
        skyConditionKeymap.set("SAND", "Sandstorm");
        skyConditionKeymap.set("SC", "Stratocumulus");
        skyConditionKeymap.set("SCSL", "Stratocumulus standing lenticular cloud");
        skyConditionKeymap.set("SCT", "Scattered cloud coverage");
        skyConditionKeymap.set("SEC", "Seconds");
        skyConditionKeymap.set("SEV", "Severe");
        skyConditionKeymap.set("SFC", "Surface");
        skyConditionKeymap.set("SG", "Snow Grains");
        skyConditionKeymap.set("SH", "Shower");
        skyConditionKeymap.set("SHWR", "Shower");
        skyConditionKeymap.set("SIGMET", "Information from MWO");
        skyConditionKeymap.set("SIR", "Snow and ice on runway");
        skyConditionKeymap.set("SKC", "CLEAR");
        skyConditionKeymap.set("SLP", "Sea Level Pressure in MB");
        skyConditionKeymap.set("SLPNO", "Sea-level pressure not available");
        skyConditionKeymap.set("SLR", "Slush on runway");
        skyConditionKeymap.set("SLW", "Slow");
        skyConditionKeymap.set("SM", "Statute Miles");
        skyConditionKeymap.set("SMK", "Smoke");
        skyConditionKeymap.set("SMO", "Supplementary meteorological office");
        skyConditionKeymap.set("SN", "Snow");
        skyConditionKeymap.set("SPECI", "Special Report");
        skyConditionKeymap.set("SQ", "Squall");
        skyConditionKeymap.set("SS", "Sandstorm");
        skyConditionKeymap.set("SSR", "Secondary Surveillance Radar");
        skyConditionKeymap.set("T", "Temperature");
        skyConditionKeymap.set("TAF", "Terminal aerodrome forecast in code");
        skyConditionKeymap.set("TAPLEY", "Tapley runway friction coefficient");
        skyConditionKeymap.set("TAR", "Terminal Area Surveillance Radar");
        skyConditionKeymap.set("TAIL", "Tail wind");
        skyConditionKeymap.set("TCH", "Threshold Crossing Height");
        skyConditionKeymap.set("TCU", "Towering Cumulus");
        skyConditionKeymap.set("TDO", "Tornado");
        skyConditionKeymap.set("TDWR", "Terminal Doppler Weather Radar");
        skyConditionKeymap.set("TEMPO", "TEMPO");
        skyConditionKeymap.set("TEND", "Trend or tending to");
        skyConditionKeymap.set("TKOF", "Takeoff");
        skyConditionKeymap.set("TMPA", "Traffic Management Program Alert");
        skyConditionKeymap.set("TODA", "Takeoff distance available");
        skyConditionKeymap.set("TOP", "Cloud top");
        skyConditionKeymap.set("TORA", "Takeoff run available");
        skyConditionKeymap.set("TS", "Thunderstorm");
        skyConditionKeymap.set("TSNO", "Thunderstorm/lightning detector not available");
        skyConditionKeymap.set("LLWS", "Low Level Wind Shear");
        skyConditionKeymap.set("TURB", "Turbulence");
        skyConditionKeymap.set("TWY", "Taxiway");
        skyConditionKeymap.set("UFN", "Until further notice");
        skyConditionKeymap.set("UNL", "Unlimited");
        skyConditionKeymap.set("UP", "Unknown Precipitation");
        skyConditionKeymap.set("UTC", "Coordinated Universal Time (=GMT)");
        skyConditionKeymap.set("V", "Variable (wind direction and RVR)");
        skyConditionKeymap.set("VA", "Volcanic Ash");
        skyConditionKeymap.set("VC", "Vicinity");
        skyConditionKeymap.set("VER", "Vertical");
        skyConditionKeymap.set("VFR", "Visual flight rules");
        skyConditionKeymap.set("VGSI", "Visual Glide Slope Indicator");
        skyConditionKeymap.set("VIS", "Visibility");
        skyConditionKeymap.set("VISNO [LOC]", "Visibility Indicator at second location not available");
        skyConditionKeymap.set("VMS", "Visual meteorological conditions");
        skyConditionKeymap.set("VOLMET", "Meteorological information for aircraft in flight");
        skyConditionKeymap.set("VRB", "Variable wind direction");
        skyConditionKeymap.set("VRBL", "Variable");
        skyConditionKeymap.set("VSP", "Vertical speed");
        skyConditionKeymap.set("VV", "Vertical Visibility (indefinite ceiling)");
        skyConditionKeymap.set("WAAS", "Wide Area Augmentation System");
        skyConditionKeymap.set("WDSPR", "Widespread");
        skyConditionKeymap.set("WEF", "With effect from");
        skyConditionKeymap.set("WIE", "With immediate effect");
        skyConditionKeymap.set("WIP", "Work in progress");
        skyConditionKeymap.set("WKN", "Weaken(ing)");
        skyConditionKeymap.set("WR", "Wet runway");
        skyConditionKeymap.set("WS", "Wind shear");
        skyConditionKeymap.set("WSHFT", "Wind shift (in minutes after the hour)");
        skyConditionKeymap.set("WSP", "Weather Systems Processor");
        skyConditionKeymap.set("WSR", "Wet snow on runway");
        skyConditionKeymap.set("WST", "Convective Significant Meteorological Information");
        skyConditionKeymap.set("WTSPT", "Waterspout");
        skyConditionKeymap.set("WW", "Severe Weather Watch Bulletin");
        skyConditionKeymap.set("WX", "Weather");
    }

    /**
     * Decode weather codes from TAFs or METARS
     * @param {*} codevalue: this could contain multiple space-delimited codes
     * @returns string with any weather description(s)
     */
    function decodeWxDescriptions(codevalue) {
        if (codevalue === "") return codevalue;
        let outstr = null;
        let vals = codevalue.split(" ");
        let wak = null;

        for (let i = 0; i < vals.length; i++) {
            if (i === 0) {
                wak = weatherAcronymKeymap.get(vals[i]).toUpperCase();
                wak ? outstr = wak : null;
            }
            else {
                wak = weatherAcronymKeymap.get(vals[i]).toUpperCase();
                wak ? outstr += ` / ${wak}` : null;
            }
        }
        return outstr;
    }

    /**
     * Get the description for an icing code
     * @param {string} code 
     * @returns string, readable description of code 
     */
    function getIcingCodeDescription(code) {
        let retvalue = icingCodeKeymap.get(code);
        if (retvalue === undefined) retvalue = code;
        return retvalue;
    }
    /**
     * Load readable descriptions for Icing codes
     */
    function loadIcingCodeKeymap() {
        icingCodeKeymap.set("0", "None");
        icingCodeKeymap.set("1", "Light");
        icingCodeKeymap.set("2", "Light in clouds")
        icingCodeKeymap.set("3", "Light in precipitation")
        icingCodeKeymap.set("4", "Moderate");
        icingCodeKeymap.set("5", "Moderate in clouds");
        icingCodeKeymap.set("6", "Moderate in precipitation");
        icingCodeKeymap.set("7", "Severe");
        icingCodeKeymap.set("8", "Severe in clouds");
        icingCodeKeymap.set("9", "Severe in precipitation");
    }

    /**
     * Get the description for a turbulence code
     * @param {string} code 
     * @returns string, readable description of code 
     */
    function getTurbulenceCodeDescription(code) {
        let retvalue = turbulenceCodeKeymap.get(code);
        if (retvalue === undefined) retvalue = code;
        return retvalue;
    }
    /**
     * Load readable descriptions for Turbulence codes
     */
    function loadTurbulenceCodeKeymap() {
        turbulenceCodeKeymap.set("0", "Light");
        turbulenceCodeKeymap.set("1", "Light");
        turbulenceCodeKeymap.set("2", "Moderate in clean air occasionally")
        turbulenceCodeKeymap.set("3", "Moderate in clean air frequent");
        turbulenceCodeKeymap.set("4", "Moderate in clouds occasionally");
        turbulenceCodeKeymap.set("5", "Moderate in clouds frequently");
        turbulenceCodeKeymap.set("6", "Severe in clean air occasionally");
        turbulenceCodeKeymap.set("7", "Severe in clean air frequent");
        turbulenceCodeKeymap.set("8", "Severe in clouds occasionally");
        turbulenceCodeKeymap.set("9", "Severe in clouds frequently");
        turbulenceCodeKeymap.set("X", "Extreme");
        turbulenceCodeKeymap.set("x", "Extreme");
    }

    const CONDITIONS = {
        //Visual Flight Rules
        VFR: "green",
        //Marginal Visual Flight Rules
        MVFR: "blue",
        //Instrument Flight Rules
        IFR: "red",
        //Low Instrument flight Rules
        LIFR: "purple"
    };
    var size = 25;
    var piD = (size / 2) * 3.14 * 2;
    //clear square
    var CLR_SQUARE = "<g id=\"clr\">\n        <rect width=\"" + size + "\" height=\"" + size + "\" x=\"calc(250 - " + size / 2 + ")\" y=\"calc(250 - " + size / 2 + ")\" class=\"coverage\"/>\n    </g>";
    //clear circle
    var CLR_CIRCLE = "<g id=\"clr\">\n        <circle cx=\"250\" cy=\"250\" r=\"" + size + "\" fill=\"#00000000\" class=\"coverage\"/>\n    </g>";
    // Few clouds 25% coverage
    var FEW = "<g id=\"few\">\n        <circle cx=\"250\" cy=\"250\" r=\"" + size + "\" fill=\"#00000000\" class=\"coverage\"/>\n        <circle cx=\"250\" cy=\"250\" r=\"" + size / 2 + "\" fill=\"#00000000\" \n        stroke-dasharray=\"0 calc(75 * " + piD + " / 100) calc(25 * " + piD + " / 100)\"\n        class=\"partial\"/>\n    </g>";
    // Scattered clouds 50% coverage
    var SCT = "<g id=\"few\">\n    <circle cx=\"250\" cy=\"250\" r=\"" + size + "\" fill=\"#00000000\" class=\"coverage\"/>\n    <circle cx=\"250\" cy=\"250\" r=\"" + size / 2 + "\" fill=\"#00000000\" \n    stroke-dasharray=\"calc(25 * " + piD + " / 100) calc(50 * " + piD + " / 100) calc(25 * " + piD + " / 100)\"\n    class=\"partial\"/>\n</g>";
    // Broken clouds 75% coverage
    var BRK = "<g id=\"few\">\n    <circle cx=\"250\" cy=\"250\" r=\"" + size + "\" fill=\"#00000000\" class=\"coverage\"/>\n    <circle cx=\"250\" cy=\"250\" r=\"" + size / 2 + "\" fill=\"#00000000\" \n    stroke-dasharray=\"calc(49 * " + piD + " / 100) calc(26 * " + piD + " / 100) calc(25 * " + piD + " / 100)\"\n    class=\"partial\"/>\n</g>";
    // Overcast
    var OVC = "<g id=\"ovc\">\n    <circle cx=\"250\" cy=\"250\" r=\"" + size + "\" class=\"ovc\"/>\n</g>";
    //Cloud abbreviation map
    let CLOUDS = {
        NCD: { svg: CLR_CIRCLE, text: "no clouds", rank: 0 },
        SKC: { svg: CLR_CIRCLE, text: "sky clear", rank: 0 },
        CLR: { svg: CLR_CIRCLE, text: "no clouds under 12,000 ft", rank: 0 },
        NSC: { svg: CLR_CIRCLE, text: "no significant", rank: 0 },
        FEW: { svg: FEW, text: "few", rank: 1 },
        SCT: { svg: SCT, text: "scattered", rank: 2 },
        BKN: { svg: BRK, text: "broken", rank: 3 },
        OVC: { svg: OVC, text: "overcast", rank: 4 },
        VV: { svg: OVC, text: "vertical visibility", rank: 5 },
    };
    /**
     * Generates SVG for cloud coverage
     * @param coverage
     * @param condition
     * @returns
     */
    function genCoverage(coverage, condition) {
        if (coverage != null && coverage !== "") {
            return "\n            <style>\n                .coverage{ \n                    stroke-width: 5; \n                    stroke: " + (condition != null ? exports.CONDITIONS[condition] : "black") + ";\n                }\n                .partial{\n                    stroke-width: 25; \n                    stroke: " + (condition != null ? exports.CONDITIONS[condition] : "black") + ";\n                }\n                .ovc{\n                    fill: " + (condition != null ? exports.CONDITIONS[condition] : "black") + ";\n                }\n            </style>\n            " + CLOUDS[coverage].svg;
        }
        else {
            return "";
        }
    }

    var RVR = /** @class */ (function () {
        function RVR(rvrString) {
            this.re = /(R\d{2})([L|R|C])?(\/)([P|M])?(\d+)(?:([V])([P|M])?(\d+))?([N|U|D])?(FT)?/g;
            var matches;
            while ((matches = this.re.exec(rvrString)) != null) {
                if (matches.index === this.re.lastIndex) {
                    this.re.lastIndex++;
                }
                this.runway = matches[1];
                this.direction = matches[2];
                this.seperator = matches[3];
                this.minIndicator = matches[4];
                this.minValue = matches[5];
                this.variableIndicator = matches[6];
                this.maxIndicator = matches[7];
                this.maxValue = matches[8];
                this.trend = matches[9];
                this.unitsOfMeasure = matches[10];
            }
        }
        return RVR;
    }());

    /**
     * Weather Descriptor
     */
    var Weather = /** @class */ (function () {
        function Weather() {
        }
        return Weather;
    }());

    /**
     * Deprecated - for internal use only please use getWeatherLegend(key: string)
     * @param key weather abbriviation
     * @returns
     */
    function getWeatherSVG(key) {
        var weather = WEATHER[key] != null ? WEATHER[key].svg : "";
        return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"65\" height=\"65\" viewBox=\"0 0 500 500\" x=\"140\" y=\"220\">\n                <style>\n                    .wx_text{ \n                        color: black;\n                        font-size: 400px;\n                        font-family: \"Noto Sans\";\n                        white-space: pre;\n                    }\n                    .snow{ \n                        color: black;\n                        font-size: 300px;\n                        font-family: \"Noto Sans\";\n                        white-space: pre;\n                    }\n                    .wx_graphic {\n                        stroke: black;\n                        fill: none;\n                        stroke-width: 30\n                    }\n                    .wx_graphic_thin {\n                        stroke: black;\n                        fill: none;\n                        stroke-width: 15\n                    }\n                </style>\n                " + weather + "\n            </svg>";
    }
    /**
     * Returns SVG icon
     * @param key weather abbriviation
     */
    function getWeatherLegend(key) {
        var weather = WEATHER[key] != null ? WEATHER[key].svg : "";
        return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"65\" height=\"65\" viewBox=\"0 0 500 500\">\n                <style>\n                    .wx_text{ \n                        color: black;\n                        font-size: 400px;\n                        font-family: \"Noto Sans\";\n                        white-space: pre;\n                    }\n                    .snow{ \n                        color: black;\n                        font-size: 300px;\n                        font-family: \"Noto Sans\";\n                        white-space: pre;\n                    }\n                    .wx_graphic {\n                        stroke: black;\n                        fill: none;\n                        stroke-width: 30\n                    }\n                    .wx_graphic_thin {\n                        stroke: black;\n                        fill: none;\n                        stroke-width: 15\n                    }\n                </style>\n                " + weather + "\n            </svg>";
    }
    var BRK_DWN_ARW = "<line class=\"wx_graphic\" x1=\"350\" y1=\"50\" x2=\"175\" y2=\"250\"></line>\n    <line class=\"wx_graphic\" x1=\"170\" y1=\"245\" x2=\"350\" y2=\"415\"></line>\n    <line class=\"wx_graphic\" x1=\"350\" y1=\"415\" x2=\"250\" y2=\"415\"></line>\n    <line class=\"wx_graphic\" x1=\"350\" y1=\"425\" x2=\"350\" y2=\"315\"></line>";
    var RIGHT_ARROW = "<line class=\"wx_graphic\" x1=\"120\" y1=\"250\" x2=\"430\" y2=\"250\"></line>\n    <line class=\"wx_graphic\" x1=\"380\" y1=\"250\" x2=\"465\" y2=\"250\" transform=\"rotate(-45, 450, 250)\"></line>\n    <line class=\"wx_graphic\" x1=\"380\" y1=\"250\" x2=\"450\" y2=\"250\" transform=\"rotate(45, 450, 250)\"></line>";
    var TRANSFORM = "transform=\"matrix(1.4,0,0,1.2,-102.2,-30.3)\"";
    var DWN_TRI = "<polygon style=\"stroke: black\" points=\"150 160 350 160 250 475\"></polygon>";
    /*
    SVG Icons
    */
    //DUST OR SAND
    var sine = "<path transform=\"matrix(1.4,0,0,1.6,-84,-118)\" style=\"fill: none; stroke: black; stroke-width: 10\" d=\"M 232.3 217.2 C 231.4 184.3 201 163.6 176.6 180.1 C 165.3 187.8 158.3 201.9 158.3 217.2\"></path>\n    <path transform=\"matrix(1.4,0,0,1.6,-121,-147)\" style=\"fill: none; stroke: black; stroke-width: 10\" d=\"M 337.1 223.5 C 337.1 255.3 304.1 275.2 277.8 259.3 C 265.6 251.9 258 238.2 258 223.5\"></path>    \n";
    //Smoke or volcanic ash
    var FU_VA = "<g id=\"FU_VA\">\n        <line class=\"wx_graphic\" x1=\"100\" y1=\"150\" x2=\"100\" y2=\"400\"></line>\n        <path class=\"wx_graphic\" d=\"M 100 150 C 115 75 185 75 200 150\"></path>\n        <path class=\"wx_graphic\" d=\"M 200 150 C 215 215 285 215 300 150\"></path>\n        <path class=\"wx_graphic\" d=\"M 300 150 C 315 75 380 75 400 150\"></path>\n    </g>";
    //Haze
    var HZ = "<g id=\"HZ\">\n        <text class=\"snow\" x=\"100\" y=\"365\">\u267E\uFE0F</text>\n    </g>";
    //Dust or Sand
    var DU_SA = "<g id=\"DU_SA\">\n        <text class=\"wx_text\" x=\"160\" y=\"360\">S</text>\n    </g>";
    //Blowing dust or sand
    var BLDU_BLSA = "<g id=\"BLDU_BLSA\">\n        <text class=\"wx_text\" x=\"160\" y=\"360\">$</text>\n    </g>";
    //Dust Devil
    var PO = "<g id=\"PO\">\n      <text class=\"wx_text\" style=\"font-size: 375px;\" x=\"50\" y=\"360\">(\u25CF)</text>\n    </g>";
    //Vicinity sand storm
    var VCSS = "<g id=\"VCSS\">\n        <text class=\"wx_text\" x=\"50\" y=\"360\">($)</text>\n        " + RIGHT_ARROW + "\n    </g>";
    //FOG OR SPEACIAL WEATHER
    //Mist or light fog
    var BR = "<g id=\"BR\">\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"200\" x2=\"450\" y2=\"200\"></line>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"300\" x2=\"450\" y2=\"300\"></line>\n    </g>";
    //More or less continuous shallow fog
    var MIFG = "<g id=\"MIFG\">\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"200\" x2=\"200\" y2=\"200\"></line>\n        <line class=\"wx_graphic\" x1=\"300\" y1=\"200\" x2=\"450\" y2=\"200\"></line>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"300\" x2=\"450\" y2=\"300\"></line>\n    </g>\n    ";
    //Vicinity thunderstorm
    var VCTS = "<g id=\"VCTS\">" + BRK_DWN_ARW + "</g>";
    //Virga or precipitation not hitting ground
    var VIRGA = "<g id=\"VIGRA\">\n        <text transform=\"matrix(0, -1, 1, 0, 366, 389)\" class=\"wx_text\" style=\"font-size:300px;\" dx=\"-5 -9\" dy=\"-40 0.5\">(\u25CF</text>\n    </g>";
    //Vicinity showers
    var VCSH = "<g id=\"VCSS\">\n        <text class=\"wx_text\" x=\"50\" y=\"360\">( )</text>\n        <circle style=\"fill: black\" cx=\"230\" cy=\"260\" r=\"50\"></circle>\n    </g>";
    //Thunderstorm with or without precipitation
    var TS = "<g id=\"TS\">\n        " + BRK_DWN_ARW + "\n        <line class=\"wx_graphic\" x1=\"355\" y1=\"50\" x2=\"50\" y2=\"50\"></line>\n        <line class=\"wx_graphic\" x1=\"60\" y1=\"50\" x2=\"60\" y2=\"440\"></line>\n    </g>\n    ";
    //Squalls
    var SQ = "<g id=\"SQ\">\n        <line class=\"wx_graphic\" x1=\"250\" y1=\"450\" x2=\"150\" y2=\"50\"></line>\n        <line class=\"wx_graphic\" x1=\"150\" y1=\"50\" x2=\"250\" y2=\"125\"></line>\n        <line class=\"wx_graphic\" x1=\"250\" y1=\"125\" x2=\"350\" y2=\"50\"></line>\n        <line class=\"wx_graphic\" x1=\"350\" y1=\"50\" x2=\"250\" y2=\"450\"></line>\n    </g>";
    //Funnel cloud or tornado
    var FC = "<g id=\"FC\">\n        <line class=\"wx_graphic\" x1=\"200\" y1=\"100\" x2=\"200\" y2=\"400\"></line>\n        <line class=\"wx_graphic\" x1=\"300\" y1=\"100\" x2=\"300\" y2=\"400\"></line>\n        <line class=\"wx_graphic\" x1=\"300\" y1=\"100\" x2=\"375\" y2=\"50\"></line>\n        <line class=\"wx_graphic\" x1=\"300\" y1=\"400\" x2=\"375\" y2=\"450\"></line>\n        <line class=\"wx_graphic\" x1=\"200\" y1=\"400\" x2=\"125\" y2=\"450\"></line>\n        <line class=\"wx_graphic\" x1=\"200\" y1=\"100\" x2=\"125\" y2=\"50\"></line>\n    </g>\n    ";
    //BLOWING WEATHER
    //Sand or dust storm
    var SS = "<g id=\"SS\">\n        <text class=\"wx_text\" x=\"160\" y=\"360\">S</text>\n        " + RIGHT_ARROW + "\n    </g>";
    //Strong sand or dust storm
    var PLUS_SS = "<g =\"+SS\">\n        <text class=\"wx_text\" x=\"160\" y=\"360\">S</text>\n    </g>";
    //Blowing snow
    var BLSN = "<g id=\"BLSN\">\n        <text x=\"0\" y=\"350\" class=\"wx_text\" transform=\"rotate(270, 250, 250)\">\u2192</text>\n        <text x=\"50\" y=\"450\" class=\"wx_text\">\u2192</text>\n    </g>";
    //Drifting snow
    var DRSN = "<g id=\"DRSN\">\n        <text x=\"110\" y=\"350\" class=\"wx_text\" transform=\"rotate(90, 250, 250)\">\u2192</text>\n        <text x=\"110\" y=\"400\" class=\"wx_text\">\u2192</text>\n    </g>\n    ";
    //FOG//////////////////////////////////////////////
    //Vicinity fog
    var VCFG = "<g id=\"VCFG\">\n        <line class=\"wx_graphic\" x1=\"100\" y1=\"150\" x2=\"400\" y2=\"150\"></line>\n        <line class=\"wx_graphic\" x1=\"100\" y1=\"250\" x2=\"400\" y2=\"250\"></line>\n        <line class=\"wx_graphic\" x1=\"100\" y1=\"350\" x2=\"400\" y2=\"350\"></line>\n        <path class=\"wx_graphic\" d=\"M 60 135 C 15 165 15 335 65 365\"></path>\n        <path class=\"wx_graphic\" d=\"M 435 135 C 485 150 500 345 435 365\"></path>\n    </g>";
    //Patchy fog
    var BCFG = "<g id=\"BCFG\">\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"150\" x2=\"150\" y2=\"150\"></line>\n        <line class=\"wx_graphic\" x1=\"350\" y1=\"150\" x2=\"450\" y2=\"150\"></line>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"250\" x2=\"450\" y2=\"250\"></line>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"350\" x2=\"150\" y2=\"350\"></line>\n        <line class=\"wx_graphic\" x1=\"350\" y1=\"350\" x2=\"450\" y2=\"350\"></line>\n    </g>";
    //Fog, sky discernable
    var PRFG = "<g id=\"BCFG\">\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"150\" x2=\"150\" y2=\"150\"></line>\n        <line class=\"wx_graphic\" x1=\"350\" y1=\"150\" x2=\"450\" y2=\"150\"></line>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"250\" x2=\"450\" y2=\"250\"></line>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"350\" x2=\"450\" y2=\"350\"></line>\n    </g>";
    //Fog, sky undiscernable
    var FG = "<g id=\"FG\">\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"150\" x2=\"450\" y2=\"150\"></line>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"250\" x2=\"450\" y2=\"250\"></line>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"350\" x2=\"450\" y2=\"350\"></line>\n    </g>";
    //Freezing fog
    var FZFG = "<g id=\"FG\">\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"150\" x2=\"450\" y2=\"150\"></line>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"250\" x2=\"450\" y2=\"250\"></line>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"350\" x2=\"450\" y2=\"350\"></line>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"150\" x2=\"250\" y2=\"350\"></line>\n        <line class=\"wx_graphic\" x1=\"450\" y1=\"150\" x2=\"250\" y2=\"350\"></line>\n    </g>";
    //Drizzle
    //Light drizzle
    var MIN_DZ = "<g id=\"-DZ\">\n        <text class=\"wx_text\" x=\"130\" y=\"240\">,,</text>\n    </g>";
    //Moderate drizzle
    var DZ = "<g id=\"RA\">\n        <text class=\"wx_text\" x=\"130\" y=\"285\">,,</text>\n        <text class=\"wx_text\" x=\"170\" y=\"175\">,</text>\n    </g>";
    //Heavy drizzle
    var PLUS_DZ = "<g id=\"RA\">\n        <text class=\"wx_text\" x=\"130\" y=\"240\">,,</text>\n        <text class=\"wx_text\" x=\"170\" y=\"145\">,</text>\n        <text class=\"wx_text\" x=\"170\" y=\"320\">,</text>\n    </g>";
    //Light freezing drizzle
    var MIN_FZDZ = "<g id=\"-DZ\" " + TRANSFORM + ">\n        <text class=\"wx_text\" x=\"130\" y=\"240\">,</text>\n        " + sine + "\n    </g>";
    //Moderate to heavy freezing drizzle
    var FZDZ = "<g id=\"-DZ\" " + TRANSFORM + ">\n        <text class=\"wx_text\" x=\"130\" y=\"240\">,,</text>\n        " + sine + "    \n    </g>";
    //Light drizzle and rain
    var MIN_DZRA = "<g id=\"MIN_DZRA>\n        <text style=\"fill: rgb(51, 51, 51); font-family: Georgia; font-size: 300px; white-space: pre;\" x=\"198.442\" y=\"348.054\" dx=\"0.743\" dy=\"-39.081\">,</text>\n        <text style=\"fill: rgb(51, 51, 51); font-family: &quot;Roboto Slab&quot;; font-size: 100px; white-space: pre;\" x=\"313.598\" y=\"154.93\" dx=\"-105.782\" dy=\"92.343\">\u25CF</text>\n    </g>";
    //Moderate to heavy drizzle and rain
    var DZRA = "<g id=\"MIN_DZRA>\n        <text x=\"198.442\" y=\"348.054\" style=\"white-space: pre; fill: rgb(51, 51, 51); font-family: &quot;Georgia&quot;; font-size: 300px;\">,</text>\n        <text style=\"fill: rgb(51, 51, 51); font-family: Georgia; font-size: 300px; white-space: pre;\" x=\"200.662\" y=\"301.835\" dx=\"-0.441\" dy=\"-136.772\">,</text>\n        <text style=\"fill: rgb(51, 51, 51); font-family: &quot;Roboto Slab&quot;; font-size: 100px; white-space: pre;\" x=\"313.598\" y=\"154.93\" dx=\"-106.683\" dy=\"133.71\">\u25CF</text>\n    </g>";
    //RAIN
    //Light rain
    var MIN_RA = "<g id=\"-RA\">\n        <text class=\"wx_text\" x=\"130\" y=\"240\">..</text>\n    </g>";
    //Moderate rain
    var RA = "<g id=\"RA\">\n        <text class=\"wx_text\" x=\"130\" y=\"285\">..</text>\n        <text class=\"wx_text\" x=\"170\" y=\"175\">.</text>\n    </g>";
    //Heavy rain
    var PLUS_RA = "<g id=\"RA\">\n        <text class=\"wx_text\" x=\"130\" y=\"240\">..</text>\n        <text class=\"wx_text\" x=\"170\" y=\"145\">.</text>\n        <text class=\"wx_text\" x=\"170\" y=\"320\">.</text>\n    </g>";
    //Light freezing rain
    var MIN_FZRA = "<g id=\"-RA\" transform=\"matrix(1.4,0,0,1.2,-102.2,-30.3)\">\n        <text class=\"wx_text\" x=\"130\" y=\"240\">.</text>\n        " + sine + "\n    </g>";
    //Moderate to heavy freezing rain
    var FZRA = "<g id=\"-RA\" " + TRANSFORM + ">\n    <text class=\"wx_text\" x=\"130\" y=\"240\">..</text>\n    " + sine + "\n    </g>";
    //Light rain and snow
    var MIN_RASN = "<g id=\"MIN_RASN\">\n        <text style=\"fill: rgb(51, 51, 51); font-family: Georgia; font-size: 200px; white-space: pre;\" x=\"198.442\" y=\"348.054\" dx=\"-0.648\" dy=\"82.18\">*</text>\n        <text style=\"fill: rgb(51, 51, 51); font-family: &quot;Roboto Slab&quot;; font-size: 200px; white-space: pre;\" x=\"313.598\" y=\"154.93\" dx=\"-129.822\" dy=\"98.015\">\u25CF</text>\n    </g>";
    //Moderate to heavy rain and snow
    var RASN = "<g id=\"RASN\">\n        <text style=\"fill: rgb(51, 51, 51); font-family: Georgia; font-size: 200px; white-space: pre;\" x=\"198.442\" y=\"348.054\" dx=\"6.111\" dy=\"137.208\">*</text>\n        <text style=\"fill: rgb(51, 51, 51); font-family: &quot;Roboto Slab&quot;; font-size: 200px; white-space: pre;\" x=\"313.598\" y=\"154.93\" dx=\"-124.964\" dy=\"158.382\">\u25CF</text>\n        <text transform=\"matrix(1, 0, 0, 1, 11.82478, 80.656288)\" style=\"fill: rgb(51, 51, 51); font-family: Georgia; font-size: 200px; white-space: pre;\" x=\"198.442\" y=\"348.054\" dx=\"-10.654\" dy=\"-182.434\">*</text>\n    </g>";
    //SNOW and MISC FROZEN PERCIP
    //Light snow
    var MIN_SN = "<g id=\"-SN\">\n        <text class=\"snow\" x=\"50\" y=\"370\">**</text>\n    </g>\n    ";
    //Moderate snow
    var SN = "<g id=\"SN\">\n        <text class=\"snow\" x=\"50\" y=\"460\">**</text>\n        <text class=\"snow\" x=\"120\" y=\"325\">*</text>\n    </g>";
    //Heavy snow
    var PLUS_SN = "<g id=\"+SN\">\n        <text class=\"snow\" x=\"50\" y=\"420\">**</text>\n        <text class=\"snow\" x=\"120\" y=\"285\">*</text>\n        <text class=\"snow\" x=\"120\" y=\"540\">*</text>\n    </g>";
    //Snow grains
    var SG = "<g id=\"SG\">\n        <polygon class=\"wx_graphic\" points=\"250 150 150 300 350 300\"></polygon>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"230\" x2=\"197\" y2=\"230\"></line>\n        <line class=\"wx_graphic\" x1=\"303\" y1=\"230\" x2=\"450\" y2=\"230\"></line>\n    </g>";
    //Ice crystals
    var IC = "<g id=\"IC\">\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"250\" x2=\"450\" y2=\"250\"></line>\n        <line class=\"wx_graphic\" x1=\"175\" y1=\"175\" x2=\"325\" y2=\"325\"></line>\n        <line class=\"wx_graphic\" x1=\"325\" y1=\"175\" x2=\"174\" y2=\"325\"></line>  \n    </g>";
    //Ice pellets
    var PE_PL = "<g id=\"PE_PL\">\n      <polygon class=\"wx_graphic\" points=\"250 150 150 300 350 300\"></polygon>\n      <text style=\"fill: black; font-size: 100px;\" x=\"237.271\" y=\"242.526\" dx=\"-18.412\" dy=\"32.137\">\u25CF</text>\n    </g>";
    //SHOWERY PERCIPITATION
    //Light rain showers
    var MIN_SHRA = "<g id=\"MIN_SHRA\">\n        <polygon class=\"wx_graphic\"  points=\"150 160 350 160 250 475\"></polygon>\n        <text x=\"190\" y=\"140\" style=\"font-size: 200px;\">\u25CF</text>\n    </g>";
    //Moderate to heavy rain showers
    var SHRA = "";
    //Light rain and snow showers
    var MIN_SHRASN = "";
    //Moderate to heavy rain and snow showers
    var SHRASN = "";
    //Light snow showers
    var MIN_SHSN = "";
    //Moderate to heavy snow showers
    var SHSN = "";
    //Light showers with hail, not with thunder
    var MIN_GR = "";
    //Moderate to heavy showers with hail, not with thunder
    var GR = "";
    // THUNDERSTORMS
    //Light to moderate thunderstorm with rain
    var TSRA = "";
    //Light to moderate thunderstorm with hail
    var TSGR = "";
    //Thunderstorm with heavy rain
    var PLUS_TSRA = "";
    /**
     * Map of weather abbriviation to SVG data and Full text
     */
    let WEATHER = {
        "FU": { svg: FU_VA, text: "Smoke" },
        "VA": { svg: FU_VA, text: "Volcanic Ash" },
        "HZ": { svg: HZ, text: "Haze" },
        "DU": { svg: DU_SA, text: "Dust" },
        "SA": { svg: DU_SA, text: "Sand" },
        "BLDU": { svg: BLDU_BLSA, text: "Blowing Dust" },
        "BLDA": { svg: BLDU_BLSA, text: "Blowing Sand" },
        "PO": { svg: PO, text: "Dust Devil" },
        "VCSS": { svg: VCSS, text: "Vicinity Sand Storm" },
        "BR": { svg: BR, text: "Mist or light fog" },
        "MIFG": { svg: MIFG, text: "Continuous Shallow Fog" },
        "VCTS": { svg: VCTS, text: "Vicinity Thunderstorm" },
        "VIRGA": { svg: VIRGA, text: "Virga" },
        "VCSH": { svg: VCSH, text: "Vicinity showers" },
        "TS": { svg: TS, text: "Thunderstorm" },
        "SQ": { svg: SQ, text: "Squall" },
        "FC": { svg: FC, text: "Funnel Cloud/Tornado" },
        "SS": { svg: SS, text: "Sand/Dust Storm" },
        "+SS": { svg: PLUS_SS, text: "Strong Sand/Dust Storm" },
        "BLSN": { svg: BLSN, text: "Blowing Snow" },
        "DRSN": { svg: DRSN, text: "Drifting Snow" },
        "VCFG": { svg: VCFG, text: "Vicinity Fog" },
        "BCFG": { svg: BCFG, text: "Patchy Fog" },
        "PRFG": { svg: PRFG, text: "Fog, Sky Discernable" },
        "FG": { svg: FG, text: "Fog, Sky Undiscernable" },
        "FZFG": { svg: FZFG, text: "Freezing Fog" },
        "-DZ": { svg: MIN_DZ, text: "Light Drizzle" },
        "DZ": { svg: DZ, text: "Moderate Drizzle" },
        "+DZ": { svg: PLUS_DZ, text: "Heavy Drizzle" },
        "-FZDZ": { svg: MIN_FZDZ, text: "Light Freezing Drizzle" },
        "FZDZ": { svg: FZDZ, text: "Moderate Freezing Drizzle" },
        "+FZDZ": { svg: FZDZ, text: "Heavy Freezing Drizzle" },
        "-DZRA": { svg: MIN_DZRA, text: "Light Drizzle & Rain" },
        "DZRA": { svg: DZRA, text: "Moderate to Heavy Drizzle & Rain" },
        "-RA": { svg: MIN_RA, text: "Light Rain" },
        "RA": { svg: RA, text: "Moderate Rain" },
        "+RA": { svg: PLUS_RA, text: "Heavy Rain" },
        "-FZRA": { svg: MIN_FZRA, text: "Light Freezing Rain" },
        "FZRA": { svg: FZRA, text: "Moderate Freezing Rain" },
        "+FZRA": { svg: FZRA, text: "Heavy Freezing Rain" },
        "-RASN": { svg: MIN_RASN, text: "Light Rain & Snow" },
        "RASN": { svg: RASN, text: "Moderate Rain & Snow" },
        "+RASN": { svg: RASN, text: "Heavy Rain & Snow" },
        "-SN": { svg: MIN_SN, text: "Light Snow" },
        "SN": { svg: SN, text: "Moderate Snow" },
        "+SN": { svg: PLUS_SN, text: "Heavy Snow" },
        "SG": { svg: SG, text: "Snow Grains" },
        "IC": { svg: IC, text: "Ice Crystals" },
        "PE": { svg: PE_PL, text: "Ice Pellets" },
        "PL": { svg: PE_PL, text: "Ice Pellets" }
    };
    let RECENT_WEATHER = {
        REBLSN: "Moderate/heavy blowing snow (visibility significantly reduced)reduced",
        REDS: "Dust Storm",
        REFC: "Funnel Cloud",
        REFZDZ: "Freezing Drizzle",
        REFZRA: "Freezing Rain",
        REGP: "Moderate/heavy snow pellets",
        REGR: "Moderate/heavy hail",
        REGS: "Moderate/heavy small hail",
        REIC: "Moderate/heavy ice crystals",
        REPL: "Moderate/heavy ice pellets",
        RERA: "Moderate/heavy rain",
        RESG: "Moderate/heavy snow grains",
        RESHGR: "Moderate/heavy hail showers",
        RESHGS: "Moderate/heavy small hail showers",
        // RESHGS: "Moderate/heavy snow pellet showers", // dual meaning?
        RESHPL: "Moderate/heavy ice pellet showers",
        RESHRA: "Moderate/heavy rain showers",
        RESHSN: "Moderate/heavy snow showers",
        RESN: "Moderate/heavy snow",
        RESS: "Sandstorm",
        RETS: "Thunderstorm",
        REUP: "Unidentified precipitation (AUTO obs. only)",
        REVA: "Volcanic Ash",
    };

    var GUST_WIDTH = 8;
    var WS_WIDTH = 8;
    /**
     * Creates a windbarb for the metar
     * @param metar
     * @returns
     */
    function genWind(metar) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
        var WDD = metar.wind_direction ? metar.wind_direction : 0;
        var WSP = metar.wind_speed ? metar.wind_speed : 0;
        var WGSP = metar.gust_speed ? metar.gust_speed : 0;
        var wind = "";
        var gust = "";
        if (WSP === 0) {
            wind =
                `<g id="calm"><ellipse id="calm-marker" stroke="#000" fill="#00000000" cx="250" cy="250" rx="35" ry="35"/></g>`;
        }
        else {
            gust = (metar.gust_speed === null || metar.gust_speed === undefined) ? "" :
                `<g id="gustBarb" transform="rotate(${WDD}, 250, 250)"> ` +
                `${genBarb1((_a = WGSP) !== null && _a !== void 0 ? _a : 0, true)} ` +
                `${genBarb2((_b = WGSP) !== null && _b !== void 0 ? _b : 0, true)} ` +
                `${genBarb3((_c = WGSP) !== null && _c !== void 0 ? _c : 0, true)} ` +
                `${genBarb4((_d = WGSP) !== null && _d !== void 0 ? _d : 0, true)} ` +
                `${genBarb5((_e = WGSP) !== null && _e !== void 0 ? _e : 0, true)} ` +
                `</g>`;
            wind =
                `<g id="windBarb" transform="rotate(${WDD}, 250, 250)">` +
                `<line stroke-width="8" y1="225" x1="250" y2="90" x2="250" stroke="#000" fill="none"/>` +
                `${genBarb1((_f = WSP) !== null && _f !== void 0 ? _f : 0, false)} ` +
                `${genBarb2((_g = WSP) !== null && _g !== void 0 ? _g : 0, false)} ` +
                `${genBarb3((_h = WSP) !== null && _h !== void 0 ? _h : 0, false)} ` +
                `${genBarb4((_j = WSP) !== null && _j !== void 0 ? _j : 0, false)} ` +
                `${genBarb5((_k = WSP) !== null && _k !== void 0 ? _k : 0, false)} ` +
                `</g>`;
        }
        return gust + wind;
    }

    /**
     * Generate first barb
     * @param speed wind or gust speed
     * @param gust set to true for gust
     * @returns
     */
    function genBarb1(speed, gust) {
        var fill = gust ? 'red' : '#000';
        var tag = gust ? 'gs' : 'ws';
        var width = gust ? GUST_WIDTH : WS_WIDTH;
        var barb = "";
        if (speed >= 10 && speed < 50) {
            //barb = `<line id="${tag}-barb-1-long" stroke-width="${width}" y1="50" x1="250" y2="50" x2="300" stroke="${fill}" transform="rotate(-35, 250, 50)"/>`;
            barb = `<line id="${tag}-barb-1-long" stroke-width="${width}" y1="90" x1="250" y2="90" x2="305" stroke="${fill}" transform="rotate(-35, 250, 90)"/>`;
        }
        else if (speed >= 50) {
            barb = `<polygon id="${tag}-barb-1-flag" points="248,98 290,68 248,68" fill="${fill}" />`;
        }
        return barb;
    }
    /**
     * Generate second barb
     * @param speed wind or gust speed
     * @param gust set to true for gust
     * @returns
     */
    function genBarb2(speed, gust) {
        var fill = gust ? 'red' : '#000';
        var tag = gust ? 'gs' : 'ws';
        var width = gust ? GUST_WIDTH : WS_WIDTH;
        var barb = "";
        if ((speed < 10) || (15 <= speed && speed < 20) || (55 <= speed && speed < 60)) {
            barb = `<line id="${tag}-barb-2-short" stroke-width="${width}" y1="110" x1="250" y2="110" x2="285" stroke="${fill}" transform="rotate(-35, 250, 110)"/>`;
        }
        else if ((15 < speed && speed < 50) || (speed >= 60)) {
            barb = `<line id="${tag}-barb-2-long" stroke-width="${width}" y1="110" x1="250" y2="110" x2="305" stroke="${fill}" transform="rotate(-35, 250, 110)"/>`;
        }
        return barb;
    }
    /**
     * Generate third barb
     * @param speed wind or gust speed
     * @param gust set to true for gust
     * @returns
     */
    function genBarb3(speed, gust) {
        var fill = gust ? 'red' : '#000';
        var tag = gust ? 'gs' : 'ws';
        var width = gust ? GUST_WIDTH : WS_WIDTH;
        var barb = "";
        if ((25 <= speed && speed < 30) || (65 <= speed && speed < 70)) {
            barb = `<line id="${tag}-barb-3-short" stroke-width="${width}" y1="150"  x1="250" y2="150" x2="285" stroke="${fill}" transform="rotate(-35, 250, 150)"/>`;
        }
        else if ((25 < speed && speed < 50) || speed >= 70) {
            barb = `<line id="${tag}-bard-3-long" stroke-width="${width}" y1="150"  x1="250" y2="150" x2="305" stroke="${fill}" transform="rotate(-35, 250, 150)"/>`;
        }
        return barb;
    }
    /**
     * Generate forth barb
     * @param speed wind or gust speed
     * @param gust set to true for gust
     * @returns
     */
    function genBarb4(speed, gust) {
        var fill = gust ? 'red' : '#000';
        var tag = gust ? 'gs' : 'ws';
        var width = gust ? GUST_WIDTH : WS_WIDTH;
        var barb = "";
        if ((35 <= speed && speed < 40) || (75 <= speed && speed < 80)) {
            barb = `<line id="${tag}-barb-4-short" stroke-width="${width}" y1="190" x1="250" y2="190" x2="285" stroke="${fill}" transform="rotate(-35, 250, 190)"/>`;
        }
        else if ((35 < speed && speed < 50) || speed >= 80) {
            barb = `<line id="${tag}-barb-4-long" stroke-width="${width}" y1="190" x1="250" y2="190" x2="305"  stroke="${fill}" transform="rotate(-35, 250, 190)"/>`;
        }
        return barb;
    }
    /**
     * Generate fifth barb
     * @param speed wind or gust speed
     * @param gust set to true for gust
     * @returns
     */
    function genBarb5(speed, gust) {
        var fill = gust ? 'red' : '#000';
        var tag = gust ? 'gs' : 'ws';
        var width = gust ? GUST_WIDTH : WS_WIDTH;
        var barb = "";
        if ((45 <= speed && speed < 50) || (85 <= speed && speed < 90)) {
            barb = `<line id="${tag}-barb-5-short" stroke-width="${width}" y1="230" x1="250" y2="230" x2="285" stroke="${fill}" transform="rotate(-35, 250, 230)"/>`;
        }
        return barb;
    }

    //Meassage types
    var TYPES = ["METAR", "SPECI"];

    /**
     * Parses a raw metar and binds or creates a METAR object
     * @param weathertext Raw Weather text string
     * @param ref Reference to a WeatherProcessItem object. This object fields will be shallow replaced with the Raw weather values.
     *  Meaning values will be updated or added but not removed.
     * @returns
     */
    function parseWeatherText(weathertext, ref) {
        var station = parseStation(weathertext);
        var time = parseDate(weathertext);
        if (ref) {
            ref.station = station;
            ref.time = time;
        }
        else {
            ref = new WeatherProcessItem(undefined, station, time);
        }
        ref.auto = parseAuto(weathertext);
        ref.wind = parseWind(weathertext);
        ref.cavok = parseCavok(weathertext);
        ref.visibility = parseVisibility(weathertext);
        ref.weather = parseWeather(weathertext);
        ref.clouds = parseClouds(weathertext);
        var temps_int = parseTempInternation(weathertext);
        if (temps_int != null) {
            ref.temperature = temps_int[0];
            ref.dewpoint = temps_int[1];
        }

        var temps_ne = parseTempNA(weathertext);
        if (temps_ne != null) {
            ref.temperature = temps_ne[0];
            ref.dewpoint = temps_ne[1];
        }

        ref.altimeter = parseAltimeter(weathertext);
        return ref;
    }

    /**
     * Parses the station name form the metar
     * @param metar raw metar
     * @returns
     */
    function parseStation(metar) {
        var re = /^(METAR\s)?([A-Z]{1,4})\s/g;
        var matches = re.exec(metar);
        if (matches != null) {
            return matches[2];
        }
        else {
            return null;
        }
    }

    /**
     * Parse Date object from metar.
     * NOTE: Raw metar data does not contain month or year data. So this function assumes this metar was created in the current month and current year
     * @param metar raw metar
     * @returns
     */
    function parseDate(metar) {
        var re = /([\d]{2})([\d]{2})([\d]{2})Z/g;
        var matches = re.exec(metar);
        if (matches != null) {
            var d = new Date();
            d.setUTCDate(parseInt(matches[1]));
            d.setUTCHours(parseInt(matches[2]));
            d.setUTCMinutes(parseInt(matches[3]));
            d.setUTCSeconds(0);
            d.setUTCMilliseconds(0);
            return d;
        }
        else {
            return null;
        }
    }

    /**
     * Parses for CAVOK (Ceiling and visabiliy OK)
     * @param metar raw metar
     * @returns
     */
    function parseCavok(metar) {
        var re = /\sCAVOK\s/g;
        return metar.match(re) != null ? true : false;
    }

    /**
     * Parses for Automation
     * @param metar raw metar
     * @returns
     */
    function parseAuto(metar) {
        var re = /\s(AUTO)?(AO1)?(AO2)?\s/g;
        return metar.match(re) != null ? true : false;
    }

    /**
     * Parse international temp dewp point format.
     * @param metar raw metar
     * @returns
     */
    function parseTempInternation(metar) {
        var re = /\s(M)?(\d{2})\/(M)?(\d{2})\s/g;
        var matches = re.exec(metar);
        if (matches != null) {
            var temp = parseInt(matches[2]) * (matches[1] == null ? 1 : -1);
            var dew_point = parseInt(matches[4]) * (matches[3] == null ? 1 : -1);
            return [temp, dew_point];
        }
    }

    /**
     * Parse North American temp dew point format
     * @param metar raw metar
     * @returns
     */
    function parseTempNA(metar) {
        var re = /(T)(\d{1})(\d{2})(\d{1})(\d{1})(\d{2})(\d{1})/g;
        var matches = re.exec(metar);
        if (matches != null) {
            var temp = parseFloat(matches[3] + "." + matches[4]) * (matches[2] === "0" ? 1 : -1);
            var dew_point = parseFloat(matches[6] + "." + matches[7]) * (matches[5] === "0" ? 1 : -1);
            return [temp, dew_point];
        }
    }

    /**
     * Parse Weather items
     * @param metar raw metar
     * @returns
     */
    function parseWeather(metar) {
        var obs_keys = Object.keys(WEATHER).join('|').replace(/\+/g, "\\+");
        var re = new RegExp("\\s?(" + obs_keys + ")\\s", 'g');
        try {
            var matches = metar.match(re);
            if (matches != null) {
                return matches.map(function (match) {
                    var key = match.trim();
                    return {
                        abbreviation: key,
                        meaning: WEATHER[key].text
                    };
                });
            }
        }
        catch { }
        return new Array();
    }

    /**
     * Parse visibility
     * @param metar raw metar
     * @returns
     */
    function parseVisibility(metar) {
        var re = /\s([0-9]{1,2})?\s?([0-9]{1}\/[0-9]{1})?(SM)\s|\s([0-9]{1,4})\s/g;
        if (metar.match(re)) {
            var vis_parts = re.exec(metar);
            if (vis_parts != null) {
                var meters = vis_parts[4];
                var miles = vis_parts[1];
                var frac_miles = vis_parts[2];
                //Metric case ex: 1000, 9999 
                if (meters != null) {
                    return parseInt(meters);
                }
                //whole miles case ex: 1SM 10SM
                else if (frac_miles != null) {
                    var total = 0.0;
                    if (miles != null) {
                        total += parseFloat(miles);
                    }
                    total += frac_miles ? parseFloat(frac_miles) : 0.0;
                    return total * 1609.34;
                }
                //factional miles case "1 1/2SM" "1/4SM"
                else {
                    return parseInt(miles) * 1609.34;
                }
            }
        }
        return undefined;
    }

    /**
     * Parse cloud coverages
     * @param metarString raw metar
     * @returns
     */
    function parseClouds(metarString) {
        var _a;
        var re = /(NCD|SKC|CLR|NSC|FEW|SCT|BKN|OVC|VV)(\d{3})/g;
        var clouds = new Array();
        var matches;
        while ((matches = re.exec(metarString)) != null) {
            var cloud = {
                abbreviation: matches[1],
                meaning: (_a = CLOUDS[matches[1]]) === null || _a === void 0 ? void 0 : _a.text,
                altitude: parseInt(matches[2]) * 100
            };
            clouds.push(cloud);
        }
        return clouds;
    }

    /**
     * Parse wind data
     * @param metar raw metar
     * @returns
     */
    function parseWind(metar) {
        var wind = new Wind();
        var re = /\s(\d{3})(\d{2})(G)?(\d{2})?(KT|MPS)\s/g;
        var matches = re.exec(metar);
        if (matches != null) {
            wind.direction = parseInt(matches[1]);
            wind.speed = parseInt(matches[2]);
            wind.unit = matches[5];
        }
        return wind;
    }

    function parseAltimeter(metar) {
        var re = /(A|Q)(\d{2})(\d{2})/g;
        var matches = re.exec(metar);
        if (matches != null) {
            if (matches[1] === "Q") {
                var pressure = parseFloat(matches[2] + matches[3]);
                return parseFloat((pressure * 0.029529).toFixed(2));
            }
            else {
                return parseFloat(matches[2] + "." + matches[3]);
            }
        }
    }


    /**
     * Turns a Weather JSON object into an SVG image
     * @param weatherobject weather JSON object
     * @param width css width of svg
     * @param height css height of svg
     * @param metric true for metric units(m, hPa, mps), false for north american units (miles, inHg, Kts)
     * @returns
     */
    function rawWeatherTextToSVG(weatherobject, width, height) {
        var plot = rawWeatherTextToWeatherPlot(weatherobject);
        return metarToSVG(plot, width, height);
    }

    /**
     *
     * @param weatherobject weather JSON object
     * @param metric true for metric units(m, hPa, mps), false for north american units (miles, inHg, Kts)
     * @returns
     */
    function rawWeatherTextToWeatherPlot(weatherobject) {
        var _a;
        const rawMetar = weatherobject.raw_text;
        const time = weatherobject.timestamp;
        const weatherItem = new WeatherProcessItem(rawMetar, weatherobject.station_id, time);
        const wx = weatherItem.weather.map(function (weather) { return weather.abbreviation; }).join("");
        const temp = cToF(weatherItem.temperature);
        const dp = cToF(weatherItem.dewpoint);
        const pressure = weatherItem.altimeter;
        const vis = milePrettyPrint((_a = weatherItem.visibility) !== null && _a !== void 0 ? _a : -1);

        return {
            visiblity: vis,
            temp: temp,
            dew_point: dp,
            station: weatherItem.station,
            wind_direction: (typeof weatherItem.wind.direction === "number") ? weatherItem.wind.direction : undefined,
            wind_speed: weatherItem.wind.speed,
            gust_speed: weatherItem.wind.gust,
            wx: wx,
            pressure: pressure,
            coverage: determineCoverage(weatherItem)
        };
    }

    /**
     * Pretty print Miles in fractions if under 1 mile
     */
    function milePrettyPrint(meters) {
        var print = "";
        if (meters === -1) {
            return print;
        }
        var miles = meters * 0.0006213712;
        //round to nearest quarter
        var text = (Math.round(miles * 4) / 4).toFixed(2).toString();
        return text.replace(".00", "");
    }

    function getCategoryColors(category) {
        switch (category) {
            case "IFR":
                return { bgcolor: "#ff0000", fgcolor: "#ffffff" };
            case "LIFR":
                return { bgcolor: "#ff00ff", fgcolor: "#ffffff" };
            case "MVFR":
                return { bgcolor: "#0000cd", fgcolor: "#ffffff" };
            case "pirep":
                return { bgcolor: "#98294c", fgcolor: "#ffffff" };
            case "VFR":
            default:
                return { bgcolor: "#12f23c", fgcolor: "#000000" };
        }
    }

    /**
     * Determines the coverage symbol
     * @param metar
     * @returns
     */
    function determineCoverage(metar) {
        var _a;
        var prevailingCoverage;
        metar.clouds.forEach(function (cloud) {
            if (prevailingCoverage != null) {
                var curr = prevailingCoverage.abbreviation != null ? CLOUDS[prevailingCoverage.abbreviation].rank : undefined;
                var rank = cloud.abbreviation != null ? CLOUDS[cloud.abbreviation].rank : undefined;
                if (rank != null) {
                    if (rank > curr) {
                        prevailingCoverage = cloud;
                    }
                }
            }
            else {
                prevailingCoverage = cloud;
            }
        });
        return (_a = prevailingCoverage === null || prevailingCoverage === void 0 ? void 0 : prevailingCoverage.abbreviation) !== null && _a !== void 0 ? _a : "";
    }
    /**
     * Turns a Metar plot object to a SVG image
     * @param metar MetarPlot Object
     * @param width css width for svg
     * @param height css height for svg
     * @returns
     */
    function metarToSVG(metar, width, height) {
        var _a, _b, _c, _d, _e, _f;
        var VIS = (_a = metar.visiblity) !== null && _a !== void 0 ? _a : "";
        var TMP = (_b = metar.temp) !== null && _b !== void 0 ? _b : "";
        var DEW = (_c = metar.dew_point) !== null && _c !== void 0 ? _c : "";
        var STA = (_d = metar.station) !== null && _d !== void 0 ? _d : "";
        var ALT = (_e = metar.pressure) !== null && _e !== void 0 ? _e : "";
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 500 500"> ` +
            //return `<svg xmlns="http://www.w3.org/2000/svg" width="95" height="50" viewBox="0 0 500 500"> ` +
            `<style> ` +
            `.txt{ font-size: 47.5px; font-family: sans-serif; } ` +
            `.tmp{ fill: red } ` +
            `.sta{ fill: grey } ` +
            `.dew{ fill: blue } ` +
            `.vis{ fill: violet } ` +
            `</style> ${(0, genWind)(metar)} ${(0, getWeatherSVG)((_f = metar.wx) !== null && _f !== void 0 ? _f : "")} ` +
            `         ${(0, genCoverage)(metar.coverage, metar.condition)} ` +
            `<g id="text"><text class="vis txt" fill="#000000" stroke="#000" stroke-width="0" x="80" y="260" text-anchor="middle" ` +
            `xml:space="preserve">${VIS}</text><text class="tmp txt" fill="#000000" stroke="#000" stroke-width="0" x="160" y="220" text-anchor="middle" ` +
            `xml:space="preserve">${TMP}</text><text class="dew txt" fill="#000000" stroke="#000" stroke-width="0" x="160"  y="315" text-anchor="middle" ` +
            `xml:space="preserve">${DEW}</text><text class="sta txt" fill="#000000" stroke="#000" stroke-width="0" x="275"  y="315" text-anchor="start" ` +
            `xml:space="preserve">${STA}</text><text class="sta txt" fill="#000000" stroke="#000" stroke-width="0" x="275"  y="220" text-anchor="start" ` +
            `xml:space="preserve">${ALT}</text></g></svg>`;
    }

    /**
     * Generate a wind barb SVG image
     * @param {int} width 
     * @param {int} height 
     * @param {object} metar 
     * @returns 
     */
    function getWindBarbSvg(width, height, metar) {
        let catcolor = "";
        let svg = "";
        let thismetar = {
            wind_direction: metar.wind_dir_degrees,
            wind_speed: metar.wind_speed_kt,
            gust_speed: metar.gust_speed_kt,
            station: metar.station_id
        };
        try {
            switch (metar.flight_category) {
                case "IFR":
                    catcolor = "ff0000";
                    break;
                case "LIFR":
                    catcolor = "ff00ff";
                    break;
                case "MVFR":
                    catcolor = "0000cd";
                    break;
                case "VFR":
                default:
                    catcolor = "12f23c";
                    break;
            }
            svg = `<svg xmlns="http://www.w3.org/2000/svg" ` +
                `width="${width}" height="${height}" ` +
                `viewBox="0 0 500 500">` +
                (0, genWind)(thismetar) +
                `<g id="clr">` +
                `<circle cx="250" cy="250" r="30" stroke="#000000" stroke-width="5" fill="#${catcolor}"/>` +
                `</g>` +
                `</svg>`;
        }
        catch { }
        return svg;
    }
    /**
     * Convert ºF to ºF
     * @param celsius
     */
    function cToF(celsius) {
        if (celsius != null) {
            return Math.round(celsius * 9 / 5 + 32);
        }
    }

    await loadTileDatabases();
    await loadUserData();
});
