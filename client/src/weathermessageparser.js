
/***********************************************************************************
 * Converts a received websocket weather object to FAA pre-processed object format *
 ***********************************************************************************/
import { getAirportInfo } from './airportfunctions.js';

/**
 * Converts a Stratux METAR object to FAA METAR format
 * @param {Object} weatherMessage - The raw Stratux METAR object
 * @param {Object} [stationInfo] - Optional lookup for lat/lon/elevation by station_id
 * @returns {Object} FAA-style METAR object
 */
export async function parseWeatherMessage(weatherMessage, stationInfo) {

    // if (weatherMessage.Type === "METAR" || weatherMessage.Type === "TAF") {
    //     if (!stationInfo) {
    //         stationInfo = await attachAirportInfo(weatherMessage.Location);
    //     }
    // }

    // Make sure stratuxObject.Location is a string airport code, e.g. "KORD"
    const cleanedData = weatherMessage.Data.replace(/\s*\n\s*/g, ' ').trim();
    const forecast = await parseWeatherForecast(weatherMessage.Data);

    // Time handling
    let timestamp = weatherMessage.Time;
    let loc_time = weatherMessage.LocaltimeReceived;


    // Weather handling
    const weatherRaw = `${weatherMessage.Location} ${timestamp} ${cleanedData}`;
    const station_id = weatherMessage.Location;
    const observation_time = await parseObservationTime(loc_time);
    const raw_text = weatherRaw;
    const metar_type = weatherMessage.Type;

    // Basic regex parsing
    const tempDewRegex = /(\d{2})\/(\d{2})/;
    const windRegex = /(\d{3})(\d{2})KT/;
    const altimRegex = /A(\d{4})/;
    const visRegex = /(\d{1,2})SM/;
    const skyRegex = /(FEW|SCT|BKN|OVC)(\d{3})/g;

    const tempDewMatch = weatherRaw.match(tempDewRegex);
    const windMatch = weatherRaw.match(windRegex);
    const altimMatch = weatherRaw.match(altimRegex);
    const visMatch = weatherRaw.match(visRegex);

    // Sky conditions
    let sky_condition = [];
    let skyMatch;
    while ((skyMatch = skyRegex.exec(weatherRaw)) !== null) {
        sky_condition.push({
            sky_cover: skyMatch[1],
            cloud_base_ft_agl: String(Number(skyMatch[2]) * 100)
        });
    }

    let visMiles = visMatch ? Number(visMatch[1]) : 10;
    let cond = "";

    if (visMiles < 1) cond = "LIFR";
    else if (visMiles < 3) cond = "IFR";
    else if (visMiles < 5) cond = "MVFR";
    else cond = "VFR";

    let output = {
        raw_text,
        //color: 
        type: weatherMessage.Type,
        station_id: station_id,
        station_name: stationInfo?.name ?? null,
        timestamp: weatherMessage.Time,
        observation_time,
        latitude: stationInfo?.lat ?? null,
        longitude: stationInfo?.lon ?? null,
        temp_c: tempDewMatch ? Number(tempDewMatch[1]) : null,
        dewpoint_c: tempDewMatch ? Number(tempDewMatch[2]) : null,
        wind_dir_degrees: windMatch ? Number(windMatch[1]) : null,
        wind_speed_kt: windMatch ? Number(windMatch[2]) : null,
        visibility_statute_mi: visMiles,
        altim_in_hg: altimMatch ? (Number(altimMatch[1]) / 100).toFixed(2) : null,
        sky_condition,
        flight_category: cond,
        metar_type,
        elevation_m: stationInfo?.elevation_m ?? null,
        forecast: forecast,
    };
    console.log(output);
    return output;
}

/**
 * Parses a TAF Data string into forecast periods with wind, visibility, and sky conditions
 * @param {string} weatherData - Raw TAF Data string
 * @returns {Array} Array of forecast objects
 */
function parseWeatherForecast(weatherData) {
    // Split into lines/periods
    const lines = weatherData
        .replace(/\n/g, ' ')
        .replace(/=+$/, '')
        .split(/(?=\bFM\d{6}|TEMPO|PROB\d{2}|BECMG)/)
        .map(line => line.trim())
        .filter(line => line.length > 0);

    const forecastPeriods = [];

    for (const line of lines) {
        // Identify type
        let type = "MAIN";
        let time = null;
        let match;

        if (line.startsWith("FM")) {
            type = "FM";
            match = line.match(/^FM(\d{6})/);
            time = match ? match[1] : null;
        } else if (line.startsWith("TEMPO")) {
            type = "TEMPO";
            match = line.match(/^TEMPO\s+(\d{4})\/(\d{4})/);
            time = match ? { from: match[1], to: match[2] } : null;
        } else if (line.startsWith("PROB")) {
            type = "PROB";
            match = line.match(/^PROB(\d{2})\s+(\d{4})\/(\d{4})/);
            time = match ? { prob: match[1], from: match[2], to: match[3] } : null;
        } else if (line.startsWith("BECMG")) {
            type = "BECMG";
            match = line.match(/^BECMG\s+(\d{4})\/(\d{4})/);
            time = match ? { from: match[1], to: match[2] } : null;
        }

        // Parse wind, visibility, and sky conditions
        const windRegex = /(\d{3})(\d{2})G?(\d{2})?KT/;
        const visRegex = /(\d{1,2})SM/;
        const skyRegex = /(FEW|SCT|BKN|OVC)(\d{3})/g;

        const windMatch = line.match(windRegex);
        const visMatch = line.match(visRegex);

        // Sky conditions
        let sky_condition = [];
        let skyMatch;
        while ((skyMatch = skyRegex.exec(line)) !== null) {
            sky_condition.push({
                sky_cover: skyMatch[1],
                cloud_base_ft_agl: String(Number(skyMatch[2]) * 100)
            });
        }

        forecastPeriods.push({
            type,
            time,
            text: line,
            wind_dir_degrees: windMatch ? Number(windMatch[1]) : null,
            wind_speed_kt: windMatch ? Number(windMatch[2]) : null,
            wind_gust_kt: windMatch && windMatch[3] ? Number(windMatch[3]) : null,
            visibility_statute_mi: visMatch ? Number(visMatch[1]) : null,
            sky_condition
        });
    }

    return forecastPeriods;
}

async function parseObservationTime(timeStr) {
    // Example: "061955Z" => "YYYY-MM-DDTHH:MM:00Z" for current day
    if (!timeStr || !/^\d{6}Z$/.test(timeStr)) return null;
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    const hour = timeStr.slice(2, 4);
    const minute = timeStr.slice(4, 6);
    return `${year}-${month}-${day}T${hour}:${minute}:00Z`;
}

// You can add more helper functions as needed
