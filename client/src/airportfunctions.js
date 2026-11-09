export async function getAirportObject(stationId) {
    try {
        const response = await fetch(`/airport?id=${stationId}`);
        if (!response.ok) {
            return {};
        }
        const resp = response.json();
        return resp;
    }
    catch (error) {
        return {};
    }
}

export async function getAirportsInRadius(lon, lat, radiusMiles) {
    try {
        const bounds = await getBoundingBox(lon, lat, radiusMiles);

        const response = await fetch(`/airportlist?minLat=${bounds.minLat}&maxLat=${bounds.maxLat}&minLon=${bounds.minLon}&maxLon=${bounds.maxLon}`);
        if (!response.ok) {
            console.log(`Bad Response: ${response.status} ${response.statusText}`);
            return [];
        }

        const airports = await response.json();

        return airports;
    }
    catch (error) {
        console.log("Error in getAirportsInRadius:", error);
        return [];
    }
}

async function getBoundingBox(centerLon, centerLat, radiusMiles) {
    const earthRadiusMiles = 3959;
    const radiusRadians = radiusMiles / earthRadiusMiles;
    const latRad = centerLat * (Math.PI / 180);

    const minLat = centerLat - (radiusRadians * 180 / Math.PI);
    const maxLat = centerLat + (radiusRadians * 180 / Math.PI);

    const deltaLon = Math.asin(Math.sin(radiusRadians) / Math.cos(latRad)) * 180 / Math.PI;
    const minLon = centerLon - deltaLon;
    const maxLon = centerLon + deltaLon;

    return { minLat, maxLat, minLon, maxLon };
}

/**
 * Decode runway surface codes to full descriptions
 * @param {string} surfaceCode - The surface code (e.g., "[CON]", "[ASP]", "grass")
 * @returns {string} - Full surface description
 */
export function decodeRunwaySurface(surfaceCode) {
    if (!surfaceCode) return '';

    // Remove brackets if present and convert to uppercase
    const code = surfaceCode.replace(/[\[\]]/g, '').toUpperCase();

    const surfaceMap = {
        'CON': 'CONCRETE',
        'ASP': 'ASPHALT',
        'ASPH-G': 'ASPHALT-GROOVED',
        'CONC': 'CONCRETE',
        'ASPH': 'ASPHALT',
        'GRASS': 'GRASS',
        'GRS': 'GRASS',
        'TURF': 'TURF',
        'DIRT': 'DIRT',
        'GRAVEL': 'GRAVEL',
        'GVL': 'GRAVEL',
        'WATER': 'WATER',
        'SNOW': 'SNOW',
        'ICE': 'ICE',
        'CORAL': 'CORAL',
        'SAND': 'SAND',
        'CLAY': 'CLAY',
        'MACADAM': 'MACADAM',
        'BRICK': 'BRICK',
        'STEEL': 'STEEL MATTING',
        'PSP': 'PIERCED STEEL PLANKING',
        'ALU': 'ALUMINUM',
        'METAL': 'METAL'
    };

    return surfaceMap[code] || code; // Return mapped value or original code if not found
}