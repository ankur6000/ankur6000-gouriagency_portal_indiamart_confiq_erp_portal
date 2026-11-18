# Gouri Agency Portal

A responsive React portal with a simple home page, client sign-in/workspace, shop order form, and an admin inbox where order statuses can be updated.

The order request form collects shop and business details, medicine names and box quantities, a required drug-license PDF/JPG, and a required signature image. The uploaded signature is extracted from light paper into a transparent black-ink PNG. Sole proprietorship orders require the owner's name; partnership orders require both partner names. Email and mobile number are mandatory. Owner photos and GST copies are optional. Uploads are limited to 5 MB per file. Each order receives a unique `GA` ID followed by six digits, and its timestamp is shown in both client and admin portals in India time.

The admin inbox groups repeat orders under a customer profile using a normalized GST number. Clients can sign in to a registered profile with its email, phone number, or GST number, view the saved profile photo, and update shop and contact details. GST and drug-license numbers are locked for clients; admins can edit all profile fields and replace uploaded documents. Admins can preview profile/order PDFs and images in the portal, download individual files, or download one shop's/all shops' documents in RAR archives named by shop. Admins can set the due amount for each order; clients can pay the outstanding balance through Razorpay Checkout. Razorpay payments are verified and captured on the API before the balance is updated. Clients can also submit offline payment references for admin review. Every new order starts as `Pending approval`; admins can approve or reject it, then move approved orders through `In progress` to `Complete`.

To enable Razorpay, copy `.env.example` to `.env`, then add your Razorpay test key ID and key secret. In PowerShell, run `Copy-Item .env.example .env`. Keep `.env` private and never commit or share the key secret. Restart the API after adding the keys; use live keys only when ready to accept real payments.

To enable automatic client emails, set `GMAIL_USER` to the sending Gmail address and `GMAIL_APP_PASSWORD` to its Gmail app password. `EMAIL_FROM` must use that same sender address. Gmail SMTP defaults to `smtp.gmail.com` on port `465` with implicit SSL; port `587` with STARTTLS is also supported by setting `GMAIL_SMTP_PORT=587` and `GMAIL_SMTP_SECURE=false`. Keep `.env` private. New registration/order, profile-change, order-update, and confirmed-payment emails include a unique 15-digit serial in the subject. Order emails attach the generated order/profile agreement PDF without a logo in the email body.

## Run locally

Install Node.js 22 or newer, then from this folder:

```sh
npm install
```

Add the MongoDB Atlas connection string to the ignored `.env` file as `MONGODB_URI`. The `dev` command starts the API, waits for its database-backed health check, and then starts the frontend:

```sh
npm.cmd run dev
```

Open the local URL Vite prints (normally `http://localhost:5173`). The API uses port 3001 and Vite forwards `/api` requests to `127.0.0.1:3001`. If the API is already healthy, the dev launcher reuses it. To run only the frontend against an API started separately, use:

```sh
npm.cmd run dev:frontend
```

## Deploy on Render

This repository includes a Render Blueprint and a step-by-step production guide in [RENDER_DEPLOYMENT.md](./RENDER_DEPLOYMENT.md). The production web service builds the frontend and serves it together with the API; MongoDB Atlas remains the persistent store.

## Demo access

- Client demo sign-in: enter the registered email, phone number, or GST number; no password is required. An email address can also open an unregistered demo workspace.
- Admin default: `admin@gouriagency.com` / `001`. Change the password after first sign-in from Admin access settings.

Profiles, orders, uploaded documents, and portal messages are persisted in MongoDB Atlas. Sign-in sessions are held in API memory and must be created again after an API restart. The admin inbox and profile/order updates are protected by bearer tokens.
