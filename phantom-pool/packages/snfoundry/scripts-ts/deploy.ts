import {
  deployContract,
  executeDeployCalls,
  exportDeployments,
  deployer,
  assertDeployerDefined,
  assertRpcNetworkActive,
  assertDeployerSignable,
} from "./deploy-contract";
import { green, red } from "./helpers/colorize-log";
import { stark } from "starknet";

const deployScript = async (): Promise<void> => {
  // 1. Declare the PhantomVault Class Hash (Required by Pool)
  // We deploy a dummy vault using placeholders just to register its class hash on-chain
  const { classHash: vaultClassHash } = await deployContract({
    contract: "PhantomVault",
    contractName: "PhantomVaultClassDummy",
    constructorArgs: {
      condenser: deployer.address,
      wbtc: deployer.address, // Placeholder until real wBTC address
    },
  });

  // 2. Deploy Real Garaga Verifiers!
  const { address: orderValidityVerifierAddr } = await deployContract({
    contract: "OrderValidityVerifier",
    contractName: "OrderValidityVerifier",
    constructorArgs: {},
  });

  const { address: matchCorrectnessVerifierAddr } = await deployContract({
    contract: "MatchCorrectnessVerifier",
    contractName: "MatchCorrectnessVerifier",
    constructorArgs: {},
  });

  const { address: condenserVerifierAddr } = await deployContract({
    contract: "CondenserVerifier",
    contractName: "CondenserVerifier",
    constructorArgs: {},
  });

  // 3. Real Testnet Addresses (Pending Tongo Deployment)
  const wBtcAddr = "0x00452bd5c0512a61df7c7be8cfea5e4f893cb40e126bdc40aee6054db955129e"; // Sepolia Bridged wBTC
  const tongoUsdcAddr = "0x2caae365e67921979a4e5c16dd70eaa5776cfc6a9592bcb903d91933aaf2552"; // Sepolia Tongo USDC.e
  
  const tongoWbtcAddr = "0x06764daf19ed17a4e133f74dada4733dda5ff8c1964da2029219cc85624f52cd"; 

  // 4. Deploy the Core PhantomPool
  const { address: poolAddr } = await deployContract({
    contract: "PhantomPool",
    contractName: "PhantomPool",
    constructorArgs: {
      order_validity_verifier: orderValidityVerifierAddr,
      match_correctness_verifier: matchCorrectnessVerifierAddr,
      condenser_verifier: condenserVerifierAddr,
      tongo_wbtc: tongoWbtcAddr, // Wait for Tongo team reply
      tongo_usdc: tongoUsdcAddr, 
      wbtc: wBtcAddr,
      phantom_vault_class_hash: vaultClassHash,
    },
  });

  // 5. Deploy PhantomExtension (Ekubo extension)
  await deployContract({
    contract: "PhantomExtension",
    contractName: "PhantomExtension",
    constructorArgs: {
      owner: deployer.address,
      phantom_pool: poolAddr,
      open_access: true, // Allow open access for testing purposes
    },
  });
};

const main = async (): Promise<void> => {
  try {
    assertDeployerDefined();

    await Promise.all([assertRpcNetworkActive(), assertDeployerSignable()]);

    await deployScript();
    await executeDeployCalls();
    exportDeployments();

    console.log(green("All Setup Done!"));
  } catch (err) {
    if (err instanceof Error) {
      console.error(red(err.message));
    } else {
      console.error(err);
    }
    process.exit(1);
  }
};

main();
