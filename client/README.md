# Create an aviation chart map website with METARs/SPECIs, WINDS, TAFs, Pireps - Using OpenLayers map API  

Key Functionality:

Map Engine: Uses OpenLayers to display aviation charts and base maps.

Offline Tiles: Supports offline tile databases (OSM, Sectional, Terminal) via a local tile server.

State Persistence: Saves and restores map view (zoom, center, rotation), layer visibility, and radar settings when the app is closed or backgrounded.

Weather & Information Overlays:
  METARs & TAFs: Visualizes weather reports and forecasts with color-coded flight categories (VFR, MVFR, IFR, LIFR). Clicking a station shows a detailed popup with decoded weather data.
  PIREPs: Displays pilot reports for turbulence, icing, and other conditions.
  Airports: Shows airports with symbols indicating type (towered, uncontrolled, heliport, seaplane) and status (closed). Popups provide frequencies and runway details (including surface type decoding).
  Radius Search: Allows searching for airports within a specific radius (10, 25, 50, 100 NM) of a point.

Technical Implementation:
  Frontend: Built with Vite and es6 JavaScript (no heavy framework like React/Vue).
  
Architecture: Modular design with separate files for map logih, data parsing, etc.
