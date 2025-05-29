const core = require("@actions/core");
const github = require("@actions/github");
const { default: axios } = require("axios");
const { spawn } = require("child_process");
const { randomBytes } = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const { getLatestBlockNumber } = require("./network");

(async () => {
  try {
    console.log("All Environment Variables:\n");

    Object.keys(process.env).forEach(key => {
      console.log(`${key} = ${process.env[key]}`);
    });
  } catch (error) {
    console.error("Error printing environment variables:", error);
  }
})();
