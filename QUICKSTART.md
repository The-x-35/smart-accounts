# Quick Start Guide

## Setup

1. **Install dependencies:**
```bash
npm install
```

2. **Create `.env.local` file:**
```bash
cp .env.example .env.local
```

3. **Configure environment variables:**
   - Set `JWT_SECRET` to a secure random string
   - Add fee payer private keys (get testnet keys for testing)
   - Configure RPC URLs

4. **Run the development server:**
```bash
npm run dev
```

## Testing the APIs

### 1. Register/Login

```bash
# Register
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'

# Login (save the token)
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'
```

### 2. Create Wallet

```bash
curl -X POST http://localhost:3000/api/wallet/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "ethPrivateKey": "0x...",
    "network": "testnet"
  }'
```

### 3. Create Multisig

```bash
curl -X POST http://localhost:3000/api/wallet/multisig \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "firstPrivateKey": "0x...",
    "secondPrivateKey": "0x...",
    "network": "testnet",
    "walletType": "both"
  }'
```

### 4. Send Transaction

```bash
curl -X POST http://localhost:3000/api/wallet/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "privateKey": "0x...",
    "walletType": "eth",
    "recipient": "0x...",
    "amount": "0.001",
    "network": "testnet"
  }'
```

## Frontend Testing

1. Navigate to http://localhost:3000
2. Click "Login" and register a new account
3. Use the dashboard to test all features:
   - Create Wallet
   - Create Multisig
   - Send Transaction

## Important Notes

- Use **testnet** for development and testing
- Ensure fee payer wallets have sufficient balance
- Private keys are never stored or logged
- All API calls require JWT authentication

