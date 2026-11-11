# mapserver

A lightweight Express-based map server and client for serving chart tiles, airport information, and weather data. The project is designed around MBTiles/SQLite map databases, with a client WebSocket stream for live weather updates.

## Overview

This project contains the server and client sides for an express server with a front end client application and serves the following:

- serves any mbtiles map tile databases found in the `tiles/` directory
- exposes map metadata and tile endpoints for map clients
- downloads current weather data from https://aviationweather.gov/
- downloads include current Metars, TAFs, and Pireps 
- download update intervals are controlled by user settings
- streams weather METAR/TAF/aircraft report data to client over WebSocket
- streams live NOAA weather radar from a starting point x minutes ago until present minute  
- provides airport lookup endpoints using a bundled world-wide airport database
- stores per-user map state in a local SQLite database using signed cookies

It is used for browser-based aviation charts, weather and meteorological overlays.

## Repository layout

- `server.js` — Express server, database loading, weather downloads, and tile endpoints
- `dist/` — static frontend assets, produced by client vite build 
- `tiles/` — MBTiles/SQLite map datasets. App Looks for MBTiles databases to serve map tiles
- `weather/` — Aviationweather.gov weather files, downloaded at a user-defined interval and immediately sent to client(s) 
- `airports.db` — SQLite airport database used for airport data, runways, and frequencies
- `mapstate.db` — user state persistence for map settings - picks up where you left off
- `config.yml` — runtime configuration for ports, weather source URLs, and app defaults

## Requirements

- Node.js 24+
- npm
- Local map database files in `tiles/` with `.db` or `.mbtiles` extensions
- Optional weather update sources and internet connectivity for pulling ADDS data

## Installation

```bash
npm install
```

## Configuration

The main runtime settings live in `config.yml`:

```yaml
httpport: 8600
startupzoom: 13
defaultposition:
  - -98.23643
  - 30.73659
```

Key settings include:

- `httpport` — HTTP server port
- `wsroute` — WebSocket endpoint path
- `startupzoom` — default map zoom
- `defaultposition` — default map center
- `wxupdateintervalmsec` — period for weather refresh checks

## Running the server

Start the app with:

```bash
npm start
```

Or run directly:

```bash
node server.js
```

The server listens on `0.0.0.0:8500` by default but will use any port you designate:

```text
http://localhost:8500/
```

## Main endpoints

- `GET /` — serves the map client
- `GET /api/config` — returns configured app settings
- `GET /api/config/edit` and `POST /api/config/edit` — configuration editor UI and persistence endpoint (`config.yml`)
- `GET /databaselist` — lists available databases
- `GET /airport?id=<identifier>` — airport lookup by identifier
- `GET /airportlist?...` — airport search/list within map bounds
- `GET /tiles/tilesets` — returns metadata for all loaded map datasets
- `GET /tiles/:dbname/:z/:x/:y` — serves map tiles
- `GET /api/userdata` and `POST /api/userdata` — fetch/update user-specific map state
- WebSocket at `/api/chartserver-stream` — live weather updates

## Weather data

The app can download weather data from ADDS endpoints and save it under `weather/`. It then broadcasts the resulting JSON to connected browser clients over the WebSocket stream.

## Notes

- The project expects map databases to exist in `tiles/` before the server can serve chart layers.
- The server creates and updates `mapstate.db` automatically on first use.
- Static assets are served from `dist/` and are intended to be used with the browser front end.

## License

This project is distributed under the Apache 2 License. See `LICENSE` for details.
