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

**Existing databases:** If you ran migrations before the GEOFENCE_ENTER/GEOFENCE_EXIT update, run the migration in `src/db/migrations/001_add_geofence_enter_exit.sql` manually. For employee invites: `npm run db:invites-migrate`.

## API Endpoints (MVP)

- `POST /auth/login`
- `POST /attendance`
- `GET /attendance/{employeeId}`
- `POST /punches` – auto classifies `ENTRY` / `MOVEMENT` / `EXIT` using geofence + employee type
- `GET /punches/{employeeId}` – recent punch history
- `POST /photos` (multipart field `photo`)
- `GET /photos/{employeeId}`
- `POST /quality` – create quality record
- `POST /quality/{qualityId}/photos` (multipart field `photo`) – upload quality photo with FE flags
- `GET /quality`
- `GET /quality/{qualityId}`
- `GET /geofences`
- `GET /orders/{orderNumber}`
- `GET /calendar/causes`
- `POST /calendar/causes` (admin/supervisor)
- `PUT /calendar/employees/{employeeId}/schedule` (admin/supervisor)
- `GET /calendar/employees/{employeeId}/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `POST /invites` (admin/supervisor) – create invite, returns invite URL
- `GET /invites/{token}` – validate invite, return employee info
- `POST /invites/{token}/complete` – set password + optional email
- `GET /invite/{token}` – web page to complete setup

