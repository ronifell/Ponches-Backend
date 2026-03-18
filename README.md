# Backend

## Environment

Copy `env.example` to `env.local`:

`cp env.example env.local`

Edit:
- `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- `JWT_SECRET`
- SMTP settings if you want email alerts
- `FCM_SERVER_KEY` if you want push notifications

## Setup

1. Install deps: `npm install`
2. Migrate: `npm run db:migrate`
3. Seed demo data: `npm run db:seed`
4. Run: `npm start`

## API Endpoints (MVP)

- `POST /auth/login`
- `POST /attendance`
- `GET /attendance/{employeeId}`
- `POST /photos` (multipart field `photo`)
- `GET /photos/{employeeId}`
- `GET /geofences`
- `GET /orders/{orderNumber}`

