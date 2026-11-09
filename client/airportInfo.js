// airportInfo.js
// Handles fetching and formatting airport info

export async function getAirportObject(stationId) {
    try {
        //console.log(`Fetching airport info for station: ${station}`);
        const response = await fetch(`/airport/${stationId}`);
        if (!response.ok) {
            console.log(`No airport info found for station: ${stationId}`);
            return null;
        }
        const airport = await response.json();
        return airport; 
    }
    catch (error) 
    {
        console.log(error);
        return {};
    }
}
