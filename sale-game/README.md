# FUT Market Radar

A dashboard of FC 27 Ultimate Team price forecasts. It shows each player's actual market price, a forecast price, the expected change in % and coins, profit after the 5% EA tax, an estimated rise time, a confidence score and the reasons behind the forecast. It refreshes every 5 seconds.

## Run it

Double-click **`start.cmd`**, or run:

```
powershell -NoProfile -ExecutionPolicy Bypass -File server.ps1
```

Then open http://localhost:8787/. There is nothing to install: the backend is a single Windows PowerShell 5.1 script.

## Where the data comes from (please read)

| Source | Status | Why |
|---|---|---|
| **FUT.GG** | Not connected by default | There is no public API. `robots.txt` disallows `/api/*`, and the Terms of Service forbid "automated means (such as bots, scrapers, or crawlers)" unless expressly permitted. |
| **FUTBIN** | Not connected by default | There is no public API, and the site returns HTTP 403 to automated clients. Getting around that would mean bypassing bot protection. |
| **Your price log** | Enabled | Prices you record yourself with **+ Log a price**. They are stored in `data/price-log.json`. |

The app never scrapes these sites and **never invents prices**. When no source supplies data, the page says so. When a source fails or goes stale, its status card turns amber or red and its players are marked *Outdated price*.

### Connecting a licensed feed

If you have written permission, a commercial licence, or your own proxy for FUT.GG/FUTBIN data, open `config.json` and set the source's `endpoint` and `"enabled": true`. Put the API key in the environment variable named by `apiKeyEnv` (for example `setx FUTGG_FEED_KEY "Bearer …"`). The key never goes in the file. The endpoint must return:

```json
{
  "players": [
    {
      "id": "unique-id", "name": "Player Name", "rating": 88, "position": "ST",
      "imageUrl": "https://…", "sourceUrl": "https://…",
      "price": 44000, "priceUpdatedAt": 1793116000000,
      "history":  [[1793030000000, 41750], [1793033600000, 42000]],
      "listings": [[1793030000000, 512]]
    }
  ]
}
```

`history` and `listings` are `[epochMs, value]` pairs or `{ "t": …, "p": … }` objects. `listings` is optional.

**Rate limits:** the browser polls the local backend every 5 s, but the backend contacts each remote source at most once per `minIntervalSec` (never more often than every 30 s). Between fetches it serves a cached copy. After an error it backs off exponentially (up to 10 min) and honours `Retry-After` on HTTP 429.

### Upcoming promotions

Copy `data/events.example.json` to `data/events.json` and fill in real dates and the price impact you expect. Forecasts only use events you configure; the app ships no promo schedule because it cannot verify one.

## How forecasts work (`public/predict.js`)

The forecast is computed per player from that player's recorded history only:

1. **Trend:** a recency-weighted log-linear regression over the last 72 h (24 h half-life), damped by fit quality (R²) and decaying over longer horizons.
2. **Momentum:** a 12 h EMA compared with a 48 h EMA.
3. **Mean reversion:** the distance from the 7-day median.
4. **Supply:** the trend in listing counts over 48 h, when available. Falling supply is bullish.
5. **Events:** the configured promo impact, discounted to 60%, applied once the event starts within the horizon.

The total move is clamped to ±50% (in log terms) and rounded to the FC price ladder. The likely range is ±1σ of the realised volatility. **Confidence** (5–95%) combines R², sample size, signal-to-noise and data freshness. **Estimated rise time** is the first hour the forecast curve clears +2%.

A forecast needs at least 6 observations spanning 6 or more hours. Players with less history show their real price and "No forecast yet".

These are statistical estimates, not guarantees or financial advice. Market crashes, content drops and EA interventions can invalidate any trend.

## Testing

- **Unit tests:** http://localhost:8787/tests/predict.test.html (17 tests for the engine).
- **QA fixtures:** synthetic data shown with a striped *TEST FIXTURE* banner. Logging is disabled in this mode:
  - `/?fixture=ok`: 12 synthetic players (uptrend, dip, crash, squeeze, volatile, insufficient history, broken image)
  - `/?fixture=empty`, `/?fixture=stale`, `/?fixture=fail` (HTTP 503), `/?fixture=slow` (3 s), `/?fixture=malformed`
- To regenerate the fixtures, run `tests/make-fixtures.ps1`.

## Files

```
server.ps1        backend: static files, /api/market, /api/log, rate limiting, fixtures
config.json       data sources
start.cmd         launcher
public/index.html dashboard markup
public/styles.css dark FUT-style theme, responsive
public/app.js     polling, rendering, filters, log dialog
public/predict.js forecast engine (pure functions)
data/             your price log and events (created on first use)
tests/            unit tests, fixture generator and fixtures
screenshots/      QA screenshots
```
