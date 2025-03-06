const core = require("@actions/core");
const github = require("@actions/github");
const { default: axios } = require("axios");
const { spawn } = require("child_process");
const { randomBytes } = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const { getLatestBlockNumber } = require("./network");

// // Default mnemonic to be used as environment variable
// const DEFAULT_MNEMONIC =
//   "test test test test test test test test test test test junk";

// // Export mnemonic as environment variable
// core.exportVariable("MNEMONIC", DEFAULT_MNEMONIC);

/**
 * Recursively walk through directories
 * @param {string} dir Directory to walk through
 * @returns {AsyncGenerator<{path: string, name: string, isFile: boolean, isDirectory: boolean}>}
 */
async function* walk(dir) {
  const files = await fs.readdir(dir, { withFileTypes: true });
  for (const dirent of files) {
    const res = path.resolve(dir, dirent.name);
    if (dirent.isDirectory()) {
      yield* walk(res);
    } else {
      yield {
        path: res,
        name: dirent.name,
        isFile: dirent.isFile(),
        isDirectory: false,
      };
    }
  }
}

/**
 * Find a directory in project root
 * @param {string} targetDir Directory name to find
 * @returns {Promise<string|null>}
 */
async function findDirectory(targetDir, workingDir) {
  try {
    const entries = await fs.readdir(workingDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name === targetDir) {
        return path.join(workingDir, entry.name);
      }
    }
    return null;
  } catch (error) {
    console.error(`Error finding directory ${targetDir}:`, error);
    return null;
  }
}

/**
 * Processes broadcast directory to collect deployment information
 * @param {string} chainId Chain identifier
 * @returns {Promise<Object>} Deployment information
 */
async function processBroadcastDirectory(chainId, workingDir) {
  try {
    // Find broadcast and build directories
    const broadcastDir = await findDirectory("broadcast", workingDir);
    if (!broadcastDir) {
      console.log("No broadcast directory found");
      return null;
    }

    const buildDir = path.join(workingDir, "build");

    // Process event ABIs from build directory
    const eventAbi = [];
    if (
      await fs
        .access(buildDir)
        .then(() => true)
        .catch(() => false)
    ) {
      for await (const entry of walk(buildDir)) {
        if (entry.isFile && entry.name.endsWith(".json")) {
          const content = await fs.readFile(entry.path, "utf8");
          const buildJson = JSON.parse(content);
          if (Array.isArray(buildJson.abi)) {
            eventAbi.push(...buildJson.abi.filter((x) => x.type === "event"));
          }
        }
      }
    }

    // Process deployment data
    const deployments = {
      transactions: [],
      receipts: [],
      libraries: [],
    };

    // Process broadcast files
    for await (const entry of walk(broadcastDir)) {
      if (
        entry.isFile &&
        entry.name === "run-latest.json" &&
        entry.path.includes(chainId.toString())
      ) {
        console.log(`Processing broadcast file: ${entry.path}`);

        const content = await fs.readFile(entry.path, "utf8");
        const runLatestJson = JSON.parse(content);

        if (runLatestJson.transactions) {
          deployments.transactions.push(...runLatestJson.transactions);
        }
        if (runLatestJson.receipts) {
          deployments.receipts.push(...runLatestJson.receipts);
        }
        if (runLatestJson.libraries) {
          deployments.libraries.push(...runLatestJson.libraries);
        }
      }
    }

    // Sort receipts by block number
    if (deployments.receipts.length > 0) {
      deployments.receipts.sort(
        (a, b) => parseInt(a.blockNumber) - parseInt(b.blockNumber),
      );

      // Sort transactions based on receipt order
      deployments.transactions.sort((a, b) => {
        const aIndex = deployments.receipts.findIndex(
          (receipt) => receipt.transactionHash === a.hash,
        );
        const bIndex = deployments.receipts.findIndex(
          (receipt) => receipt.transactionHash === b.hash,
        );
        return aIndex - bIndex;
      });

      // Process logs
      deployments.receipts = deployments.receipts.map((receipt) => ({
        ...receipt,
        decodedLogs: receipt.logs.map((log) => {
          try {
            return {
              eventName: "Event",
              data: log.data,
              topics: log.topics,
            };
          } catch (e) {
            console.log("Error decoding log:", e);
            return null;
          }
        }),
      }));
    }

    return deployments;
  } catch (error) {
    console.error("Error processing broadcast directory:", error);
    throw error;
  }
}

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
  try {
    const sandboxId = `${repoName}-${commitHash.slice(0, 8)}-${randomBytes(4).toString("hex")}`;
    const url = "https://api.dev.buildbear.io/v1/buildbear-sandbox";
    const bearerToken = core.getInput("buildbear-token", { required: true });

    const data = {
      chainId: Number(chainId),
      nodeName: sandboxId.toString(),
      blockNumber: blockNumber ? Number(blockNumber) : undefined,
    };

    const response = await axios.post(url, data, {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
      },
    });

    core.exportVariable("BUILDBEAR_RPC_URL", response.data.rpcUrl);
    core.exportVariable("MNEMONIC", response.data.mnemonic);
    return {
      url: response.data.rpcUrl,
      sandboxId,
    };
  } catch (error) {
    console.error(
      "Error creating node:",
      error.response?.data || error.message,
    );
    throw error;
  }
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
        params: [],
      });

      // Check if status is 200 and if result is absent
      if (resp.status === 200 && resp.data.result) {
        console.log(`Sandbox is live: ${url}`);
        return true;
      }
    } catch (error) {
      console.log(error);
      console.error(
        `Attempt ${attempts + 1}: Sandbox is not live yet. Retrying...`,
      );
    }

    // Wait for the specified delay before the next attempt
    await new Promise((resolve) => setTimeout(resolve, delay));
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
async function executeDeploy(deployCmd, workingDir) {
  const promise = new Promise((resolve, _) => {
    const child = spawn(deployCmd, { shell: true, cwd: workingDir });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.on("exit", (code, _) => {
      if (code == 1) {
        console.error(`Executing the deploy command failed`);
        core.setFailed(`Executing the deploy command failed`);
      } else {
        console.log("Deployment completed successfully");
      }
      resolve();
    });
  });

  await promise;
}

/**
 * Extracts relevant contract data for notification
 * @param {Object|Array} data - Deployment data to extract from
 * @returns {Array} - Array of extracted contract data
 */
const extractContractData = (data) => {
  const arrayData = Array.isArray(data) ? data : [data]; // Ensure data is an array

  return arrayData.map((item) => ({
    chainId: item.chainId || null,
    rpcUrl: item.rpcUrl || null,
    sandboxId: item.sandboxId || null,
    transactions: Array.isArray(item.deployments?.transactions)
      ? item.deployments.transactions
          .filter((tx) => tx.contractName && tx.hash && tx.contractAddress) // Filter out incomplete transactions
          .map((tx) => ({
            contractName: tx.contractName,
            hash: tx.hash,
            contractAddress: tx.contractAddress,
          }))
      : [], // Default to an empty array if transactions are missing
  }));
};

/**
 * Sends deployment notification to the backend service
 * @param {Object} deploymentData - The deployment data to send
 */
async function sendNotificationToBackend(deploymentData) {
  try {
    const githubActionUrl = `https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/actions/runs/${github.context.runId}`;
    const notificationEndpoint =
      "https://798e-2401-4900-1cbd-6646-20c3-74e8-633d-d51e.ngrok-free.app/ci/webhook";
    
    let status = deploymentData.status;
    let summary = deploymentData.summary ?? "";
    let deployments = [];
    
    // Process deployment data if not "deployment started" or already "failed"
    if (status !== "started" && status !== "failed") {
      // Extract contract data
      deployments = extractContractData(deploymentData.deployments);
      
      // Validate deployment success
      const validation = validateDeployment(deployments);
      
      if (!validation.valid) {
        // Update status to failed if validation fails
        status = "failed";
        summary = validation.message;
      }
    }
    
    const payload = {
      timestamp: new Date().toISOString(),
      status: status,
      payload: {
        repositoryName: github.context.repo.repo,
        repositoryOwner: github.context.repo.owner,
        actionUrl: githubActionUrl,
        commitHash: github.context.sha,
        workflow: github.context.workflow,
        message: summary,
        deployments: deployments,
      }
    };
    await axios.post(notificationEndpoint, payload);
    
    // If the status was changed to failed, we should fail the GitHub Action
    if (status === "failed" && deploymentData.status !== "failed") {
      core.setFailed(summary);
    }
  } catch (error) {
    console.log(error);
    // Don't throw error to prevent action failure due to notification issues
  }
}

/**
 * Validates if deployment was successful by checking if any valid transactions exist
 * @param {Array} extractedData - Data extracted from deployments
 * @returns {Object} - Validation result with status and message
 */
const validateDeployment = (extractedData) => {
  // Check if we have any valid transactions across all deployments
  const hasValidTransactions = extractedData.some(
    (deployment) => deployment.transactions && deployment.transactions.length > 0
  );

  if (!hasValidTransactions) {
    return {
      valid: false,
      message: "No contract deployments found. All transactions are missing required data.",
    };
  }
  
  return {
    valid: true,
    message: "Deployment successful",
  };
};

(async () => {
  try {
    let deploymentNotificationData = {
      status: "started",
    };
    await sendNotificationToBackend(deploymentNotificationData);
    // Get the input values
    const network = JSON.parse(core.getInput("network", { required: true }));
    const deployCmd = core.getInput("deploy-command", { required: true });
    const workingDir = path.join(
      process.cwd(),
      core.getInput("working-directory", {
        required: false,
      }),
    );
    const repoName = github.context.repo.repo; // Get repository name
    const commitHash = github.context.sha; // Get commit hash

    console.log("Network details:", network);
    console.log(`Deploy command: ${deployCmd}`);

    // Initialize array to store all deployments
    const allDeployments = [];

    // Loop through the network and create nodes
    for (const net of network) {
      console.log(`\n🔄 Processing network with chainId: ${net.chainId}`);

      let blockNumber;

      if (net.blockNumber === undefined) {
        // If blockNumber is not present in the network object, retrieve the latest block number
        blockNumber = await getLatestBlockNumber(parseInt(net.chainId));
      } else {
        // If blockNumber is present in the network object, use it
        blockNumber = net.blockNumber;
      }

      console.log(`Block number for chainId ${net.chainId}: ${blockNumber}`);
      // Create node
      const { url: rpcUrl, sandboxId } = await createNode(
        repoName,
        commitHash,
        net.chainId,
        blockNumber,
      );

      // Check if the node is live by continuously checking until successful or max retries
      const isNodeLive = await checkNodeLiveness(rpcUrl);

      if (isNodeLive) {
        console.log(`\n📄 Executing deployment for chainId ${net.chainId}`);
        // 5 seconds delay before logging the URL
        setTimeout(() => {}, 5000);

        // Execute the deploy command after node becomes live
        await executeDeploy(deployCmd, workingDir);

        // Process broadcast directory
        const deploymentData = await processBroadcastDirectory(
          net.chainId,
          workingDir,
        );

        // Set deployment details as output
        const deploymentDetails = {
          chainId: net.chainId,
          rpcUrl,
          sandboxId,
          status: "success",
          deployments: deploymentData,
        };

        // Add to deployments array
        allDeployments.push(deploymentDetails);
      } else {
        console.error(
          `Node is not live for URL: ${rpcUrl}. Skipping deployment.`,
        );
      }
    }

    console.log("=".repeat(100));
    // Print final summary for all deployments
    console.log("\n\n🚀🚀 DEPLOYMENT SUMMARY");
    console.log("=".repeat(100));

    allDeployments.forEach((deployment, index) => {
      console.log(`\nChain ID: ${deployment.chainId}`);

      if (deployment.status === "failed") {
        console.log(`Status: ❌ Failed`);
        console.log(`Error: ${deployment.error}`);
        console.log("=".repeat(100));
        return;
      }

      console.log(`Sandbox ID: ${deployment.sandboxId}`);
      console.log(`RPC URL: ${deployment.rpcUrl}`);
      console.log("\nDeployed Contracts:");

      if (deployment.deployments && deployment.deployments.receipts) {
        deployment.deployments.receipts
          .filter((receipt) => receipt.contractAddress)
          .forEach((receipt, idx) => {
            const transaction = deployment.deployments.transactions.find(
              (tx) =>
                tx.contractAddress?.toLowerCase() ===
                receipt.contractAddress?.toLowerCase(),
            );
            const contractName = transaction
              ? transaction.contractName
              : "Unknown Contract";

            console.log(
              `\n${idx + 1}. ${contractName}: ${receipt.contractAddress || "N/A"}`,
            );
            console.log(`   Transaction Hash: ${receipt.transactionHash}`);
            console.log(`   Block Number: ${receipt.blockNumber}`);
            console.log(`   Gas Used: ${receipt.gasUsed}`);
            console.log(
              `   Cumulative Gas Used : ${receipt.cumulativeGasUsed}`,
            );
            console.log(
              `   Effective Gas Price : ${receipt.effectiveGasPrice}`,
            );
          });
      }

      // Add separator between deployments
      if (index < allDeployments.length - 1) {
        console.log("\n" + "=".repeat(100));
      }
    });

    deploymentNotificationData = {
      status: "success",
      deployments: allDeployments,
    };
    await sendNotificationToBackend(deploymentNotificationData);
  } catch (error) {
    let deploymentNotificationData = {
      status: "failed",
      summary: `Deployment failed`,
      deployments: [],
    };
    await sendNotificationToBackend(deploymentNotificationData);

    core.setFailed(error.message);
  }
})();
