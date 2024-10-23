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
 * Creates a sandbox node and returns the buildbear RPC URL.
 * 
 * @param {string} repoName - The repository name
 * @param {string} commitHash - The commit hash
 * @param {number} chainId - The chain ID for the fork
 * @param {number} blockNumber - The block number for the fork
 * @returns {string} - The buildbear RPC URL for the sandbox node
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
        fork: { id: chainId, blockNumber },
        chainId: parseInt(chainId),
      },
    ],
  };

  axios.post(url, data)

  console.log(`Created sandbox ID: ${sandboxId}`);
  console.log(`Buildbear RPC URL: ${url}`);

  // Export RPC URL as environment variable for later use
  core.exportVariable('BUILDBEAR_RPC_URL', url);

  return url;
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
      console.log(`Node created with URL: ${url}`);
    }

    // Execute the deploy command after nodes have been created
    await executeDeploy(deployCmd);

  } catch (error) {
    core.setFailed(error.message);
  }
})();
