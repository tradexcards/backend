# TradeX Backend

API server and oracle keeper for the TradeX perpetual futures exchange. Fetches Pokemon card prices from TCGPlayer, publishes them on-chain to Solana, and serves trading data to the frontend via REST and WebSocket.

**Live API:** https://backend.tradex.cards  
**API Docs:** https://backend.tradex.cards/api/docs  
**OpenAPI Spec:** https://backend.tradex.cards/api/docs/json

## Technology

- **Runtime:** [Bun](https://bun.sh/)
- **Framework:** [Elysia](https://elysiajs.com/)
- **Database:** SQLite (via `bun:sqlite`)
- **Blockchain:** Solana (via `@solana/web3.js`)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Backend Server                          │
│                                                                 │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌─────────────┐  │
│  │  Routes  │   │ Services │   │  Loops   │   │   Oracle    │  │
│  │ (Elysia) │   │          │   │          │   │   Keeper    │  │
│  │          │   │ tcgplayer│   │ pricing  │──>│             │  │
│  │ /cards   │   │ analyzer │   │ prefetch │   │ publish to  │  │
│  │ /trading │   │ db       │   │ sync     │   │ Solana      │  │
│  │ /oracle  │   │ perpdex  │   │          │   │             │  │
│  └──────────┘   └──────────┘   └──────────┘   └─────────────┘  │
│        │              │              │               │          │
│        └──────────────┴──────────────┴───────────────┘          │
│                              │                                   │
│                        ┌─────┴──────┐                           │
│                        │   SQLite   │                           │
│                        │  cards.db  │                           │
│                        └────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
         │                    │                    │
         v                    v                    v
    ┌─────────┐      ┌──────────────┐     ┌────────────┐
    │ Frontend │      │  TCGPlayer   │     │   Solana   │
    └─────────┘      └──────────────┘     └────────────┘
```

## API Endpoints

### Cards (`/api/cards`)

| Method | Path            | Description                                |
| ------ | --------------- | ------------------------------------------ |
| GET    | `/overview`     | Top tradable cards ranked by score         |
| GET    | `/search?q=...` | Search cards by name                       |
| GET    | `/:id`          | Full card details with pricing and history |
| GET    | `/:id/listings` | Active marketplace listings                |
| GET    | `/:id/sales`    | Recent sales data                          |
| GET    | `/:id/history`  | Price history (month/annual)               |
| POST   | `/batch`        | Fetch multiple cards in one request        |
| GET    | `/:id/signals`  | Trading signals and recommendations        |

### Trading (`/api/trading`)

| Method | Path                        | Description                      |
| ------ | --------------------------- | -------------------------------- |
| GET    | `/exchange`                 | Global exchange state            |
| GET    | `/market/:productId`        | Market state for a product       |
| GET    | `/account/:owner`           | User trading account             |
| GET    | `/account/:owner/positions` | User's open positions            |
| GET    | `/portfolio/:owner`         | Complete portfolio with PnL      |
| GET    | `/prepare-trade/:productId` | Pre-trade validation             |
| POST   | `/simulate`                 | Trade simulation with scenarios  |
| GET    | `/analytics/movers`         | Top gainers, losers, volatile    |
| GET    | `/config`                   | Trading parameters               |
| GET    | `/tradable`                 | List of tradable product IDs     |
| POST   | `/tx/open-position`         | Build open position transaction  |
| POST   | `/tx/close-position`        | Build close position transaction |
| POST   | `/tx/deposit`               | Build deposit transaction        |
| POST   | `/tx/withdraw`              | Build withdraw transaction       |

### Oracle (`/api/oracle`)

| Method | Path          | Description                |
| ------ | ------------- | -------------------------- |
| GET    | `/status`     | Oracle keeper status       |
| GET    | `/prices`     | All current prices         |
| GET    | `/:productId` | Price for specific product |

### System (`/api/system`)

| Method | Path               | Description                      |
| ------ | ------------------ | -------------------------------- |
| GET    | `/health`          | Health check                     |
| GET    | `/health/detailed` | Detailed health with diagnostics |

### WebSocket (`/ws/trading`)

Real-time updates for prices, positions, and market events.

| Event             | Description                      |
| ----------------- | -------------------------------- |
| `price_update`    | New price for subscribed product |
| `position_opened` | Position opened notification     |
| `position_closed` | Position closed notification     |
| `market_stats`    | Market statistics update         |

## Services

### Oracle Keeper

Publishes TCGPlayer prices on-chain to Solana:

- Creates price feed PDAs for each product
- Publishes prices in batches every 30 seconds
- Supports delegated feeds for low-latency updates

### Card Analyzer

Scores cards on 7 criteria for trading suitability:

- Oracle reliability
- Price level
- Volatility character
- Demand persistence
- Market depth
- Transaction volume
- Manipulation resistance

### Background Loops

| Loop          | Interval | Purpose                          |
| ------------- | -------- | -------------------------------- |
| `dailySync`   | 24h      | Download archives, analyze cards |
| `pricing`     | 30s      | Fetch and publish live prices    |
| `prefetch`    | 6h       | Warm caches for active products  |
| `marketStats` | 30s      | Refresh on-chain market data     |

## Development

```bash
# Install dependencies
bun install

# Start development server (hot reload)
bun run dev

# Type check
bunx tsc --noEmit

# Production start
bun run start
```

## Configuration

Environment variables (from `../.env`):

| Variable              | Description              | Default           |
| --------------------- | ------------------------ | ----------------- |
| `HOST`                | Server bind address      | `0.0.0.0`         |
| `PORT`                | Server port              | `8001`            |
| `SOLANA_RPC_URL`      | Solana RPC endpoint      | devnet            |
| `PROGRAM_ID`          | On-chain program address | -                 |
| `USDC_MINT`           | USDC token mint          | -                 |
| `KEEPER_ENABLED`      | Enable oracle keeper     | `true`            |
| `KEEPER_KEYPAIR_PATH` | Keypair for signing      | `../keypair.json` |

See [`.env.example`](../.env.example) for all options.

## Code Structure

```
src/
├── index.ts          Entry point and boot sequence
├── app.ts            Elysia app factory
├── env.ts            Configuration
├── routes/           HTTP endpoints
│   ├── cards.ts      Card data endpoints
│   ├── trading.ts    Trading endpoints
│   ├── oracle.ts     Oracle endpoints
│   ├── dashboard.ts  Dashboard endpoints
│   ├── system.ts     System endpoints
│   └── ws.ts         WebSocket handlers
├── services/
│   ├── db.ts         SQLite database
│   ├── tcgplayer.ts  TCGPlayer API client
│   ├── analyzer.ts   Card scoring engine
│   ├── loops.ts      Background tasks
│   ├── oracle/       Oracle keeper
│   └── perpdex/      On-chain state reader
└── models/           TypeScript types
```

## License

Business Source License 1.1 (BUSL-1.1), non-commercial use only.
Automatically changes to GNU GPLv3 on 2030-02-18.
