import { createKernelAccount, createKernelAccountClient, createZeroDevPaymasterClient, getUserOperationGasPrice } from '@zerodev/sdk';
import { getEntryPoint, KERNEL_V3_0 } from '@zerodev/sdk/constants';
import { createWeightedECDSAValidator, getUpdateConfigCall } from '@zerodev/weighted-ecdsa-validator';
import { http, createPublicClient, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, sepolia } from 'viem/chains';
import { Network } from '@/types/api';
import { getEthRpc, getZeroDevProjectId } from '@/lib/config/networks';
import { ZeroDevWalletResult, ZeroDevMultisigResult, ZeroDevTransferResult } from './types';

/**
 * Initialize ZeroDev client
 */
async function initZeroDev(network: Network) {
  const projectId = getZeroDevProjectId(network);
  const rpc = getEthRpc(network);
  const chain = network === 'mainnet' ? mainnet : sepolia;

  const BUNDLER_RPC = `https://rpc.zerodev.app/api/v3/${projectId}/chain/${chain.id}`;
  const PAYMASTER_RPC = `https://rpc.zerodev.app/api/v3/${projectId}/chain/${chain.id}`;

  const entryPoint = getEntryPoint('0.7');

  const publicClient = createPublicClient({
    transport: http(rpc),
    chain,
  });

  return { publicClient, chain, entryPoint, BUNDLER_RPC, PAYMASTER_RPC, rpc };
}

/**
 * Get smart wallet for a private key
 */
async function getSmartWallet(privateKey: string, network: Network) {
  const { publicClient, chain, entryPoint, BUNDLER_RPC, PAYMASTER_RPC, rpc } = await initZeroDev(network);

  const signer = privateKeyToAccount(privateKey as `0x${string}`);

  // Construct a validator
  const multisigValidator = await createWeightedECDSAValidator(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_0,
    config: {
      threshold: 100,
      signers: [{
        address: signer.address,
        weight: 100,
      }],
    },
    signers: [signer],
  });

  // Construct a Kernel account
  const account = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_0,
    plugins: {
      sudo: multisigValidator,
    },
  });

  const zerodevPaymaster = createZeroDevPaymasterClient({
    chain,
    transport: http(PAYMASTER_RPC),
  });

  // Construct a Kernel account client
  const kernelClient = createKernelAccountClient({
    account,
    chain,
    bundlerTransport: http(rpc),
    client: publicClient,
    paymaster: network !== 'mainnet' ? {
      getPaymasterData(userOperation) {
        return zerodevPaymaster.sponsorUserOperation({ userOperation });
      },
    } : undefined,
    userOperation: {
      estimateFeesPerGas: async ({ bundlerClient }) => {
        return getUserOperationGasPrice(bundlerClient);
      },
    },
  });

  return kernelClient;
}

/**
 * Create ZeroDev smart wallet
 */
export async function createZeroDevWallet(
  ethPrivateKey: string,
  network: Network
): Promise<ZeroDevWalletResult> {
  const kernelClient = await getSmartWallet(ethPrivateKey, network);
  const address = kernelClient.account.address;

  // Check if already deployed
  const isDeployed = await kernelClient.account.isDeployed();

  if (isDeployed) {
    return {
      address,
    };
  }

  // Deploy the account with an empty transaction
  // The account will be deployed on first transaction
  return {
    address,
  };
}

/**
 * Create 2-of-2 multisig wallet
 */
export async function createZeroDevMultisig(
  firstPrivateKey: string,
  secondPrivateKey: string,
  network: Network
): Promise<ZeroDevMultisigResult> {
  const firstSigner = privateKeyToAccount(firstPrivateKey as `0x${string}`);
  const secondSigner = privateKeyToAccount(secondPrivateKey as `0x${string}`);

  // Get smart wallet for first signer
  const kernelClient = await getSmartWallet(firstPrivateKey, network);

  // Check if deployed
  const isDeployed = await kernelClient.account.isDeployed();

  if (!isDeployed) {
    // Deploy first with empty transaction
    await kernelClient.sendUserOperation({
      callData: await kernelClient.account.encodeCalls([]),
    });
  }

  // Create signer list for 2-of-2 (threshold 200, each signer weight 100)
  const signerList = [
    {
      address: firstSigner.address,
      weight: 100,
    },
    {
      address: secondSigner.address,
      weight: 100,
    },
  ];

  // Update config to add second signer with threshold 200 (2-of-2)
  const { publicClient, chain, entryPoint, BUNDLER_RPC, PAYMASTER_RPC } = await initZeroDev(network);

  const multisigValidator = await createWeightedECDSAValidator(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_0,
    config: {
      threshold: 200, // 2-of-2 (each signer has weight 100)
      signers: signerList,
    },
    signers: [firstSigner],
  });

  const account = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_0,
    address: kernelClient.account.address,
    plugins: {
      sudo: multisigValidator,
    },
  });

  const zerodevPaymaster = createZeroDevPaymasterClient({
    chain,
    transport: http(PAYMASTER_RPC),
  });

  const updatedKernelClient = createKernelAccountClient({
    account,
    chain,
    bundlerTransport: http(BUNDLER_RPC),
    client: publicClient,
    paymaster: network !== 'mainnet' ? {
      getPaymasterData(userOperation) {
        return zerodevPaymaster.sponsorUserOperation({ userOperation });
      },
    } : undefined,
    userOperation: {
      estimateFeesPerGas: async ({ bundlerClient }) => {
        return getUserOperationGasPrice(bundlerClient);
      },
    },
  });

  // Send update config transaction
  const updateConfigCall = getUpdateConfigCall(entryPoint, KERNEL_V3_0, {
    threshold: 200,
    signers: signerList,
  });

  const userOpHash = await updatedKernelClient.sendUserOperation({
    callData: await account.encodeCalls([updateConfigCall]),
  });

  const receipt = await updatedKernelClient.waitForUserOperationReceipt({ hash: userOpHash });

  return {
    address: account.address,
    threshold: 2,
    signers: [firstSigner.address, secondSigner.address],
    transactionHash: receipt.receipt.transactionHash,
    explorerUrl: `https://${network === 'mainnet' ? 'etherscan.io' : 'sepolia.etherscan.io'}/tx/${receipt.receipt.transactionHash}`,
  };
}

/**
 * Send ETH transaction
 */
export async function sendETHTransaction(
  privateKeys: string[],
  recipient: string,
  amount: string, // in ETH
  network: Network
): Promise<ZeroDevTransferResult> {
  const signers = privateKeys.map(key => privateKeyToAccount(key as `0x${string}`));
  const signerList = signers.map(signer => ({
    address: signer.address,
    weight: 100,
  }));

  // Get smart wallet for first signer
  const kernelClient = await getSmartWallet(privateKeys[0], network);

  // Check if deployed
  const isDeployed = await kernelClient.account.isDeployed();

  if (!isDeployed) {
    throw new Error('Wallet not deployed. Please create the wallet first.');
  }

  // For multisig, we need to use the account with all signers
  const { publicClient, chain, entryPoint, BUNDLER_RPC, PAYMASTER_RPC, rpc } = await initZeroDev(network);

  const threshold = signers.length * 100; // Each signer has weight 100

  const multisigValidator = await createWeightedECDSAValidator(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_0,
    config: {
      threshold,
      signers: signerList,
    },
    signers: signers,
  });

  const account = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_0,
    address: kernelClient.account.address,
    plugins: {
      sudo: multisigValidator,
    },
  });

  const zerodevPaymaster = createZeroDevPaymasterClient({
    chain,
    transport: http(PAYMASTER_RPC),
  });

  const transactionClient = createKernelAccountClient({
    account,
    chain,
    bundlerTransport: http(rpc),
    client: publicClient,
    paymaster: network !== 'mainnet' ? {
      getPaymasterData(userOperation) {
        return zerodevPaymaster.sponsorUserOperation({ userOperation });
      },
    } : undefined,
    userOperation: {
      estimateFeesPerGas: async ({ bundlerClient }) => {
        return getUserOperationGasPrice(bundlerClient);
      },
    },
  });

  // Create transfer transaction
  const amountWei = parseEther(amount);
  const transaction = {
    to: recipient as `0x${string}`,
    value: amountWei,
    data: '0x' as `0x${string}`,
  };

  const userOpHash = await transactionClient.sendUserOperation({
    callData: await account.encodeCalls([transaction]),
  });

  const receipt = await transactionClient.waitForUserOperationReceipt({ hash: userOpHash });

  return {
    transactionHash: receipt.receipt.transactionHash,
    explorerUrl: `https://${network === 'mainnet' ? 'etherscan.io' : 'sepolia.etherscan.io'}/tx/${receipt.receipt.transactionHash}`,
    amount,
    recipient,
  };
}

