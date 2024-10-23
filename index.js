const core = require('@actions/core');
const github = require('@actions/github');
const { exec } = require('child_process');

try {
  // Get the input values
  const network = JSON.parse(core.getInput('network'));
  const deployCmd = core.getInput('deployCmd');

  // Log the network details
  console.log('Network details:');
  network.forEach((net) => {
    console.log(`Name: ${net.name}`);
    console.log(`URL: ${net.url}`);
    console.log(`Chain ID: ${net.chainId}`);
    console.log('---');
  });

  // Log the deploy command
  console.log(`Deploy command: ${deployCmd}`);


  // Execute the deploy command
  exec(deployCmd, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error executing deploy command: ${error.message}`);
      core.setFailed(error.message);
      return;
    }

    console.log(`Deploy command output: ${stdout}`);

    if (stderr) {
      console.warn(`Deploy command stderr: ${stderr}`);
    }

    console.log('Deployment completed successfully');
  });

} catch (error) {
  core.setFailed(error.message);
}