require("dotenv").config();

const express = require("express");
const path = require("path");
const { MongoClient } = require("mongodb");

const app = express();
const port = Number(process.env.PORT || 3000);
const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const databaseName = process.env.MONGODB_DB || "cafems";
const client = new MongoClient(mongoUri);

app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));

let stateCollection;

app.get("/api/health", async function (_req, res) {
  try {
    await client.db(databaseName).command({ ping: 1 });
    res.json({ ok: true, database: databaseName });
  } catch (error) {
    console.error("MongoDB health check failed:", error.message);
    res.status(503).json({ ok: false, error: "MongoDB is not available." });
  }
});

app.get("/api/state", async function (_req, res) {
  try {
    const document = await stateCollection.findOne({ _id: "cafems" });
    res.json({ state: document ? document.state : null });
  } catch (error) {
    console.error("Could not read application state:", error.message);
    res.status(500).json({ error: "Could not read application state." });
  }
});

app.put("/api/state", async function (req, res) {
  if (!req.body || !req.body.state || typeof req.body.state !== "object" || Array.isArray(req.body.state)) {
    return res.status(400).json({ error: "A valid state object is required." });
  }

  try {
    await stateCollection.replaceOne(
      { _id: "cafems" },
      { _id: "cafems", state: req.body.state, updatedAt: new Date() },
      { upsert: true }
    );
    res.status(204).end();
  } catch (error) {
    console.error("Could not save application state:", error.message);
    res.status(500).json({ error: "Could not save application state." });
  }
});

async function start() {
  await client.connect();
  stateCollection = client.db(databaseName).collection("application_state");
  await stateCollection.createIndex({ updatedAt: 1 });
  app.listen(port, function () {
    console.log("CafeMS running at http://localhost:" + port);
    console.log("MongoDB database: " + databaseName);
  });
}

start().catch(function (error) {
  console.error("Unable to start CafeMS:", error.message);
  process.exitCode = 1;
});
