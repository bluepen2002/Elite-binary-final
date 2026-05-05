# Elite Binary Backend Integration

This package runs the existing trading UI with a local Node backend.

## Run

```bash
npm start
```

Open:

```text
http://localhost:3000
```

## Admin Controls

Default admin key:

```text
change-this-admin-key
```

Change it before production:

```bash
set ADMIN_KEY=your-secure-key
npm start
```

The admin panel in the app can update:

- Payout rate
- Global win probability
- Settlement delay
- Designated deposit wallet
- Mock payment mode

## Payment Notes

`mockPayments` is enabled by default. In this mode:

- M-Pesa STK deposits are recorded and credited immediately.
- Withdrawals are recorded and marked as paid immediately.

Trades are settled by the backend with server-side fair settlement. Admins can update operational settings, but cannot force user wins or losses.

For production M-Pesa, copy `.env.production.example`, set real callback URLs and the provider-issued passkey/B2C credentials, expose the callback URLs publicly, then set `mockPayments` to `false` in the admin panel:

```bash
set MPESA_ENV=sandbox
set MPESA_BASIC_AUTH=your-base64-basic-auth
set MPESA_CONSUMER_KEY=your-key
set MPESA_CONSUMER_SECRET=your-secret
set MPESA_SHORTCODE=your-paybill
set MPESA_PASSKEY=your-stk-passkey
set MPESA_CALLBACK_URL=https://your-domain.com/api/mpesa/stk-callback
set MPESA_B2C_SHORTCODE=your-b2c-shortcode
set MPESA_B2C_INITIATOR_NAME=your-initiator
set MPESA_B2C_SECURITY_CREDENTIAL=your-security-credential
set MPESA_B2C_RESULT_URL=https://your-domain.com/api/mpesa/b2c-result
npm start
```

Deposits call Daraja STK Push and credit the user ledger only after a successful callback. Withdrawals call Daraja B2C and automatically refund the user ledger if the provider returns a failed result.
