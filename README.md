# Swig Smart Wallet API

A Next.js TypeScript application for creating and managing Swig smart wallets on Ethereum and Solana with fee sponsorship and JWT authentication.

## Features

- **Create Smart Wallets**: Generate unique ETH and Solana smart wallets from Ethereum private keys
- **Multisig Support**: Create 2-of-2 multisig wallets for enhanced security
- **Transaction Sending**: Send ETH and SOL transactions with fee sponsorship
- **JWT Authentication**: Secure API access with JWT tokens
- **Fee Sponsorship**: Backend fee payer for gasless transactions
- **Network Support**: Both mainnet and testnet support

## Getting Started

### Prerequisites

- Node.js 18+ 
- npm, yarn, or pnpm

### Installation

1. Clone the repository and navigate to the project:
```bash
cd swig-wallet-api
```

2. Install dependencies:
```bash
npm install
```

3. Create `.env.local` file from `.env.example`:
```bash
cp .env.example .env.local
```

4. Configure environment variables in `.env.local`:
   - Set `JWT_SECRET` to a secure random string
   - Add fee payer private keys for mainnet/testnet
   - Configure RPC URLs and ZeroDev project IDs

5. Run the development server:
```bash
npm run dev
```

6. Open [http://localhost:3000](http://localhost:3000) in your browser

## API Endpoints

All API endpoints require JWT authentication via `Authorization: Bearer <token>` header.

### Authentication

- `POST /api/auth/register` - Register a new user
- `POST /api/auth/login` - Login and get JWT token
- `GET /api/auth/verify` - Verify JWT token

### Wallet Operations

- `POST /api/wallet/create` - Create ETH and Solana wallets from private key
- `POST /api/wallet/multisig` - Create 2-of-2 multisig wallets
- `POST /api/wallet/send` - Send ETH or SOL transactions

### Health Check

- `GET /api/health` - Health check endpoint

## API Documentation

### Create Wallet

**Endpoint:** `POST /api/wallet/create`

**Request:**
```json
{
  "ethPrivateKey": "0x...",
  "network": "mainnet" | "testnet"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "ethAddress": "0x...",
    "ethSmartWallet": "0x...",
    "solanaAddress": "...",
    "swigId": [1, 2, ...],
    "network": "mainnet",
    "transactionHashes": {
      "solana": "..."
    }
  }
}
```

### Create Multisig

**Endpoint:** `POST /api/wallet/multisig`

**Request:**
```json
{
  "firstPrivateKey": "0x...",
  "secondPrivateKey": "0x...",
  "network": "mainnet" | "testnet",
  "walletType": "eth" | "solana" | "both"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "ethMultisig": {
      "address": "0x...",
      "threshold": 2,
      "signers": ["0x...", "0x..."],
      "transactionHash": "0x..."
    },
    "solanaMultisig": {
      "address": "...",
      "threshold": 2,
      "signers": ["0x...", "0x..."],
      "transactionHash": "..."
    }
  }
}
```

### Send Transaction

**Endpoint:** `POST /api/wallet/send`

**Request:**
```json
{
  "privateKey": "0x...",
  "walletType": "eth" | "solana",
  "recipient": "0x...",
  "amount": "0.001",
  "network": "mainnet" | "testnet",
  "secondPrivateKey": "0x..." // Optional, for multisig
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "transactionHash": "0x...",
    "explorerUrl": "https://...",
    "amount": "0.001",
    "recipient": "0x...",
    "network": "mainnet"
  }
}
```

## Frontend Pages

- `/` - Home page
- `/login` - Login/Register page
- `/dashboard` - Main dashboard
- `/create-wallet` - Create wallet form
- `/create-multisig` - Create multisig form
- `/send-transaction` - Send transaction form

## Security Notes

- **Private Keys**: Never commit private keys to version control
- **JWT Secret**: Use a strong, random JWT secret in production
- **Fee Payers**: Ensure fee payer wallets have sufficient balance
- **Environment Variables**: Keep `.env.local` secure and never commit it

## Development

```bash
# Run development server
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Lint code
npm run lint
```

## Project Structure

```
swig-wallet-api/
├── src/
│   ├── app/
│   │   ├── api/          # API routes
│   │   └── ...           # Frontend pages
│   ├── lib/
│   │   ├── swig/         # Swig wallet client
│   │   ├── zerodev/      # ZeroDev client
│   │   ├── auth/         # Authentication
│   │   └── config/       # Configuration
│   └── types/            # TypeScript types
└── ...
```

## License

ISC

