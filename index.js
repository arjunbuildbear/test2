const core = require('@actions/core');
const github = require('@actions/github');
const { default: axios } = require('axios');
const { exec } = require('child_process');
const { randomBytes } = require('crypto');
const util = require('util');

// Promisify exec for better async/await usage
const execAsync = util.promisify(exec);

// Default mnemonic to be used as environment variable
const DEFAULT_MNEMONIC = "test test test test test test test test test test test junk";

// Export mnemonic as environment variable
core.exportVariable('MNEMONIC', DEFAULT_MNEMONIC);

/**
 * Creates a sandbox node and returns the BuildBear RPC URL.
 * 
 * @param {string} repoName - The repository name
 * @param {string} commitHash - The commit hash
 * @param {number} chainId - The chain ID for the fork
 * @param {number} blockNumber - The block number for the fork
 * @returns {string} - The BuildBear RPC URL for the sandbox node
 */
async function createNode(repoName, commitHash, chainId, blockNumber) {
  const sandboxId = `${repoName}-${commitHash.slice(0, 8)}-${randomBytes(4).toString("hex")}`;
  const url = `https://rpc-beta.buildbear.io/submit/${sandboxId}`;

  const data = {
    jsonrpc: "2.0",
    id: 1,
    method: "buildbearInternal_createNode",
    params: [
      {
        fork: { id: chainId.toString(), blockNumber },
        chainId: parseInt(chainId),
      },
    ],
  };

  await axios.post(url, data);

  console.log(`Created sandbox ID: ${sandboxId}`);
  console.log(`BuildBear RPC URL: ${url}`);

  // Export RPC URL as environment variable for later use
  core.exportVariable('BUILDBEAR_RPC_URL', url);

  return url;
}

/**
 * Checks if the node is ready by continuously polling for status.
 * 
 * @param {string} url - The BuildBear RPC URL
 * @param {number} maxRetries - Maximum number of retries before giving up
 * @param {number} delay - Delay between retries in milliseconds
 * @returns {boolean} - Returns true if the node becomes live, otherwise false
 */
async function checkNodeLiveness(url, maxRetries = 10, delay = 5000) {
  let attempts = 0;
  while (attempts < maxRetries) {
    try {
      const resp = await axios.post(url, {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_chainId",
        params: []
      });

      console.log(resp.status, resp.data)

      // Check if status is 200 and if result is absent
      if (resp.status === 200 && !resp.data.result) {
        console.log(`Node is live: ${url}`);
        return true;
      }
    } catch (error) {
      console.error(`Attempt ${attempts + 1}: Node is not live yet. Retrying...`);
    }

    // Wait for the specified delay before the next attempt
    await new Promise(resolve => setTimeout(resolve, delay));
    attempts++;
  }

  console.error(`Node did not become live after ${maxRetries} attempts.`);
  return false;
}

/**
 * Executes the deployment command.
 * 
 * @param {string} deployCmd - The command to deploy the contracts
 */
async function executeDeploy(deployCmd) {
  try {
    const { stdout, stderr } = await execAsync(deployCmd);
    console.log(`Deploy command output: ${stdout}`);
    if (stderr) {
      console.warn(`Deploy command stderr: ${stderr}`);
    }
    console.log('Deployment completed successfully');
  } catch (error) {
    console.error(`Error executing deploy command: ${error.message}`);
    core.setFailed(error.message);
  }
}

(async () => {
  try {
    // Get the input values
    const network = JSON.parse(core.getInput('network'));
    const deployCmd = core.getInput('deployCmd');
    const repoName = github.context.repo.repo; // Get repository name
    const commitHash = github.context.sha; // Get commit hash

    console.log('Network details:', network);
    console.log(`Deploy command: ${deployCmd}`);

    // Loop through the network and create nodes
    for (const net of network) {
      const url = await createNode(repoName, commitHash, net.chainId, net.blockNumber);

      // Check if the node is live by continuously checking until successful or max retries
      const isNodeLive = await checkNodeLiveness(url);
      if (isNodeLive) {
        // 5 seconds delay before logging the URL
        setTimeout(() => {
          console.log(`Node created with URL: ${url}`);
        }, 5000);

        // Execute the deploy command after node becomes live
        await executeDeploy(deployCmd);
      } else {
        console.error(`Node is not live for URL: ${url}. Skipping deployment.`);
      }
    }

  } catch (error) {
    core.setFailed(error.message);
  }
})();
