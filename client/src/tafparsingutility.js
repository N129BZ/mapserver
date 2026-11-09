export async function getCurrentTafFlightCategoryColors(rawTafText) {
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth(); // 0-11
    
    // Normalize string: clear extra spaces and break down line by line
    const lines = rawTafText.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0);
        
    if (lines.length === 0) return "VFR";

    let basePeriod = null;
    const activeTimeline = [];

    // Helper: Turn TAF DDHHMM or DDHH/DDHH strings into actual UTC timestamps
    function parseTafDate(dayStr, hourStr, minuteStr = "00") {
        return Date.UTC(currentYear, currentMonth, parseInt(dayStr), parseInt(hourStr), parseInt(minuteStr));
    }

    // Step 1: Scan header line for station validation period (e.g., 2218/2324)
    const header = lines[0];
    const baseValidMatch = header.match(/(\d{2})(\d{2})\/(\d{2})(\d{2})/);
    if (baseValidMatch) {
        basePeriod = {
            type: "BASE",
            start: parseTafDate(baseValidMatch[1], baseValidMatch[2]),
            end: parseTafDate(baseValidMatch[3], baseValidMatch[4]),
            rawText: header
        };
        activeTimeline.push(basePeriod);
    }

    // Step 2: Loop through operational forecast changes
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        
        // Match FROM groups (e.g., FM222100)
        if (line.startsWith("FM")) {
            const fmMatch = line.match(/^FM(\d{2})(\d{2})(\d{2})/);
            if (fmMatch) {
                activeTimeline.push({
                    type: "FM",
                    start: parseTafDate(fmMatch[1], fmMatch[2], fmMatch[3]),
                    end: null, // Filled dynamically below
                    rawText: line
                });
            }
        } 
        // Match TEMPO or PROB groups (e.g., TEMPO 2222/2302)
        else if (line.startsWith("TEMPO") || line.startsWith("PROB")) {
            const conditionalMatch = line.match(/^(TEMPO|PROB\d{2})\s+(\d{2})(\d{2})\/(\d{2})(\d{2})/);
            if (conditionalMatch) {
                activeTimeline.push({
                    type: conditionalMatch[1].startsWith("PROB") ? "PROB" : "TEMPO",
                    start: parseTafDate(conditionalMatch[2], conditionalMatch[3]),
                    end: parseTafDate(conditionalMatch[4], conditionalMatch[5]),
                    rawText: line
                });
            }
        }
    }

    // Step 3: Sort timeline chronological elements and resolve end-caps for FM lines
    const chronologicalFms = activeTimeline.filter(p => p.type === "BASE" || p.type === "FM")
        .sort((a, b) => a.start - b.start);
        
    for (let j = 0; j < chronologicalFms.length; j++) {
        if (chronologicalFms[j].type === "BASE" && basePeriod) {
            chronologicalFms[j].end = basePeriod.end;
        }
        // An FM block's validity is capped when the subsequent FM block takes over
        if (chronologicalFms[j].type === "FM") {
            chronologicalFms[j].end = chronologicalFms[j + 1] ? chronologicalFms[j + 1].start : basePeriod.end;
        }
    }

    // Step 4: Identify what conditions are active right now (UTC)
    const nowTimestamp = Date.now();
    let currentActiveLineText = header; // Default fallback to base setup

    // Find the currently reigning permanent baseline block
    const currentBaseGroup = chronologicalFms.reverse().find(p => nowTimestamp >= p.start && nowTimestamp < p.end);
    if (currentBaseGroup) {
        currentActiveLineText = currentBaseGroup.rawText;
    }

    // Check if a temporary group takes precedence over the baseline block right now
    const activeTempos = activeTimeline.filter(p => p.type === "TEMPO" && nowTimestamp >= p.start && nowTimestamp < p.end);
    if (activeTempos.length > 0) {
        // Use the active TEMPO conditions if present
        currentActiveLineText = activeTempos[activeTempos.length - 1].rawText;
    }

    // Step 5: Evaluate the flight category metrics for the isolated active text block
    const fc = calculateMetrics(currentActiveLineText);
    switch (fc) {
        case "IFR":
            return { category: "IFR", bgcolor: "#ff0000", fgcolor: "#ffffff" };
        case "LIFR":
            return { category: "LIFR", bgcolor: "#ff00ff", fgcolor: "#ffffff" };
        case "MVFR":
            return { category: "MVFR", bgcolor: "#0000cd", fgcolor: "#ffffff" };
        case "pirep":
            return { category: "NA", bgcolor: "#98294c", fgcolor: "#ffffff" };
        case "VFR":
        default:
            return { category: "VFR", bgcolor: "#12f23c", fgcolor: "#000000" };
    }
}

// Reusable metrics calculator engine
function calculateMetrics(lineString) {
    let visibility = 6; 
    const visMatch = lineString.match(/(\d+\/\d+|\d+|P\d+)SM/);
    if (visMatch) {
        const visValue = visMatch[1];
        if (visValue.includes('P')) visibility = 6;
        else if (visValue.includes('/')) {
            const [num, den] = visValue.split('/').map(Number);
            visibility = num / den;
        } else visibility = Number(visValue);
    }

    let ceiling = Infinity;
    const cloudRegex = /(BKN|OVC|VV)(\d{3})/g;
    let match;
    while ((match = cloudRegex.exec(lineString)) !== null) {
        const heightAGL = Number(match[2]) * 100;
        if (heightAGL < ceiling) ceiling = heightAGL;
    }

    if (ceiling < 500 || visibility < 1) return "LIFR";
    if (ceiling < 1000 || visibility < 3) return "IFR";
    if (ceiling <= 3000 || visibility <= 5) return "MVFR";
    return "VFR";
}
