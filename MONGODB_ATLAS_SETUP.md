# MongoDB Atlas setup

The portal API requires MongoDB Atlas. It will not start against an empty or missing connection URI.

For Render deployment, use the Render outbound CIDR instructions in [RENDER_DEPLOYMENT.md](./RENDER_DEPLOYMENT.md). Do not allowlist your changing home IP for the hosted service.

## Configure Atlas

1. Create an Atlas project and cluster.
2. In **Database & Network Access**, create a database user for the portal. Give the user `readWrite` access to the `gouri_agency` database. This is a MongoDB database user, not the Atlas website login.
3. Add the public IP address of the machine or deployment that runs the API to the project's **IP Access List**. For production, use the API host's stable egress IP. Avoid `0.0.0.0/0` for a permanent deployment.
4. In the cluster's **Connect** dialog, choose **Drivers** and copy the Node.js connection string.
5. Add the URI to the ignored local `.env` file:

   ```dotenv
   MONGODB_URI=mongodb+srv://PORTAL_USER:ENCODED_PASSWORD@your-cluster.example.mongodb.net/?retryWrites=true&w=majority
   MONGODB_DB_NAME=gouri_agency
   ```

   Replace the example values with the URI from Atlas. Percent-encode reserved characters in the database username or password. Keep the URI private; do not commit `.env` or paste credentials into chat.

6. Restart the API with `npm run server`. The health endpoint should return `storage: "MongoDB Atlas"`.

## Stored data

The API keeps the portal's customer records, orders, payments, trash, settings, email queue, and credentials in a compressed state snapshot in the `portal_state_snapshots` GridFS bucket. The `portal_state` collection holds the current snapshot pointer. Home slider uploads are in the `home_slider_assets` GridFS bucket. Each API request checks Atlas for the latest snapshot so separate API processes can refresh their in-memory view.

If a legacy `server/.portal-state.json` exists on first startup against an empty Atlas database, the API imports it into Atlas. The legacy file is left in place as a backup. After the Atlas pointer has been initialized, Atlas is the source of truth.

The `mongodb` Node.js driver is already included in the project dependencies.
