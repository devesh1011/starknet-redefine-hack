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

  // 2. Generate random mock addresses for the verifier contracts
  // (We temporarily disabled compiling these in lib.cairo for speed)
  const dummyVerifier1 = "0x" + stark.randomAddress();
  const dummyVerifier2 = "0x" + stark.randomAddress();
  const dummyVerifier3 = "0x" + stark.randomAddress();

  // 3. Real Testnet Addresses (Pending Tongo Deployment)
  const officialWbtcAddr = "0x00452bd5c0512a61df7c7be8cfea5e4f893cb40e126bdc40aee6054db955129e"; // Sepolia Bridged wBTC
  const officialTongoUsdcAddr = "0x2caae365e67921979a4e5c16dd70eaa5776cfc6a9592bcb903d91933aaf2552"; // Sepolia Tongo USDC.e
  
  // Custom Tongo Wrapped wBTC (Deployed by us!)
  const officialTongoWbtcAddr = "0x06764daf19ed17a4e133f74dada4733dda5ff8c1964da2029219cc85624f52cd"; 

  // 4. Deploy the Core PhantomPool
  const { address: poolAddr } = await deployContract({
    contract: "PhantomPool",
    contractName: "PhantomPool",
    constructorArgs: {
      order_validity_verifier: dummyVerifier1,
      match_correctness_verifier: dummyVerifier2,
      condenser_verifier: dummyVerifier3,
      tongo_wbtc: officialTongoWbtcAddr, // Wait for Tongo team reply
      tongo_usdc: officialTongoUsdcAddr, 
      wbtc: officialWbtcAddr,
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
