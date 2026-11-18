# Deploy Gouri Agency Portal on Render

This project deploys as one Render web service. The service serves the built React site and its `/api` endpoints from the same URL. Customer data, uploaded documents, and slider uploads stay in MongoDB Atlas; the Render filesystem is not used as the permanent data store.

## 1. Put the source in a private GitHub repository

Render deploys this project from a Git provider. Create a **private** GitHub repository and upload the project source, including `render.yaml`, `.node-version`, `package.json`, `package-lock.json`, `server/`, `src/`, `public/`, and `index.html`.

Do not upload or commit `.env`, `node_modules/`, or `dist/`. `.env` is ignored by `.gitignore`; enter its required values in the Render Environment settings instead. Render installs from `package-lock.json` and builds `dist/` during deploy.

## 2. Create the Render service

1. In Render, choose **New → Blueprint** and connect the private GitHub repository.
2. Render reads `render.yaml` and creates a **Free** web service in **Singapore**. Keep the service in that region when setting up MongoDB access.
3. Enter the MongoDB URI, admin login, live Razorpay key ID and secret, and a Razorpay webhook secret. Keep all secret values private.
4. Apply the Blueprint. The portal and its API will be available at the Render service URL.

The Free web service sleeps after 15 minutes without incoming traffic and can take about a minute to wake. Its background reconciliation timers do not run while it is asleep. An accepted client cancellation requests a Razorpay refund directly in that API request. The portal also runs a reconciliation pass when the service starts or wakes, and the webhook below helps it catch late payment captures and keep refund status current. Use this setup for evaluation, not as a guarantee of uninterrupted, time-critical payment processing. Customer records and documents remain in MongoDB Atlas, not on Render's temporary filesystem.

**Email limitation:** Render Free blocks outbound SMTP on ports 25, 465, and 587, so the current Gmail SMTP integration will not send email from this plan. Email automation requires a paid Render service or a future HTTPS email-provider integration.

## 3. Allow the Render service to connect to Atlas

The portal no longer needs your home or office IP on Atlas. After the Render service is created:

1. Open the service in Render and choose **Connect → Outbound**. Copy every outbound CIDR range shown for the Singapore service.
2. In MongoDB Atlas, open **Security → Network Access → IP Access List → Add IP Address**.
3. Add the Render CIDR ranges, with a comment such as `Gouri Agency Render Singapore`, and save.
4. In Render, open **Environment** and confirm `MONGODB_URI` is the Atlas connection string for a database user that has `readWrite` access to `gouri_agency`.

This uses Render's service egress ranges instead of changing the allowlist whenever your personal IP changes. Render's shared ranges can be updated over time. For a fixed allowlist, Render offers dedicated outbound IPs on Pro workspaces for an additional fee. Avoid `0.0.0.0/0` unless you knowingly accept allowing connections from any IP; Atlas warns that it broadens exposure.

## 4. Check the deploy

Open the Render service URL and check `<your-render-url>/api/health`. It should return JSON containing `"ok":true` and `"storage":"MongoDB Atlas"`. The first request after the service sleeps can take about a minute. Then test client/admin sign-in, order submission, PDF downloads, and the image slider.

Before sharing the public URL, sign in as admin and set a strong password under Admin access settings. If Atlas already contains portal data, its saved admin credentials remain authoritative; the Render admin variables only seed a new, empty Atlas portal state.

If the deploy fails, open **Logs** in Render and check the first startup error. Common causes are a missing `MONGODB_URI`, a database user/password that needs URL-encoding, or missing Render CIDR ranges in Atlas.

## Environment variables

The Blueprint asks for these secrets without storing their values in the repository:

- `MONGODB_URI`
- `ADMIN_LOGIN_EMAIL` and `ADMIN_PASSWORD` (used to seed admin credentials only when Atlas has no saved portal state; otherwise use the existing admin credentials)
- `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` (use live values to accept live payments)
- `RAZORPAY_WEBHOOK_SECRET` (must match the secret entered in Razorpay's webhook settings)

The Blueprint supplies the database name and Gmail sender/SMTP settings. It intentionally does not ask for `GMAIL_APP_PASSWORD` on the Free plan because Render blocks Gmail SMTP there. Email jobs will remain marked as needing configuration. After upgrading to a paid service, add `GMAIL_APP_PASSWORD` in Render Environment to enable Gmail SMTP.

## Configure Razorpay webhooks

After the Render service is deployed:

1. In Razorpay Dashboard, open **Account & Settings → Webhooks** and add a webhook URL of `https://<your-render-service>.onrender.com/api/webhooks/razorpay`.
2. Create a webhook secret. Put the exact same value in the Render environment variable `RAZORPAY_WEBHOOK_SECRET`, then save the environment change so Render redeploys.
3. Subscribe to `payment.captured`, `payment.failed`, `refund.created`, `refund.updated`, `refund.processed`, and `refund.failed`.

The portal directly requests a refund when a client cancels an eligible, captured Razorpay payment; that request does not depend on a webhook. The webhook reports captured or late-captured payments and refund status changes back to the portal. Razorpay can retry failed webhook deliveries, but a sleeping Free service can delay acknowledgement and processing. Review webhook delivery logs in Razorpay after setup.

## Updating the site

Push changes to the connected GitHub branch. Render will build and deploy that revision automatically. Keep `.env` local; update production secrets from the Render service's **Environment** page.
