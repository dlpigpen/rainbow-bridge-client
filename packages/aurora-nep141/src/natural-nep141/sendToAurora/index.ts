import BN from 'bn.js'
import { ethers } from 'ethers'
import { transactions, Account, utils } from 'near-api-js'
import { getBridgeParams, track, untrack } from '@near-eth/client'
import { TransactionInfo, TransferStatus } from '@near-eth/client/dist/types'
import * as status from '@near-eth/client/dist/statuses'
import { getNearAccount } from '@near-eth/client/dist/utils'
import { urlParams, buildIndexerTxQuery } from '@near-eth/utils'
import getMetadata from '../getMetadata'

export const SOURCE_NETWORK = 'near'
export const DESTINATION_NETWORK = 'aurora'
export const TRANSFER_TYPE = '@near-eth/aurora-nep141/natural-nep141/sendToAurora'

const LOCK = 'lock-natural-nep141-to-aurora'

export interface TransferDraft extends TransferStatus {
  type: string
  lockHashes: string[]
}

export interface Transfer extends TransactionInfo, TransferDraft {
  id: string
  startTime: string
  decimals: number
  destinationTokenName: string
  recipient: string
  sender: string
  sourceTokenName: string
  symbol: string
}

const transferDraft: TransferDraft = {
  // Attributes common to all transfer types
  // amount,
  completedStep: null,
  // destinationTokenName,
  errors: [],
  // recipient,
  // sender,
  // sourceToken,
  // sourceTokenName,
  // decimals,
  status: status.IN_PROGRESS,
  type: TRANSFER_TYPE,

  // Attributes specific to natural-erc20-to-nep141 transfers
  lockHashes: []
}

/* eslint-disable @typescript-eslint/restrict-template-expressions */
export const i18n = {
  en_US: {
    steps: (_transfer: Transfer) => [],
    statusMessage: (transfer: Transfer) => {
      switch (transfer.status) {
        case 'in-progress': return 'Confirming transaction'
        case 'failed': return last(transfer.errors)
        default: return 'Completed'
      }
    },
    callToAction: (transfer: Transfer) => {
      if (transfer.status === status.FAILED) return 'Retry'
      return null
    }
  }
}
/* eslint-enable @typescript-eslint/restrict-template-expressions */

/**
 * Called when status is FAILED
 * @param transfer Transfer object to act on.
 */
export async function act (transfer: Transfer): Promise<Transfer> {
  switch (transfer.completedStep) {
    case null:
      try {
        if (transfer.sourceToken === 'NEAR') {
          return await lockNear(transfer)
        } else {
          return await lock(transfer)
        }
      } catch (error) {
        console.error(error)
        if (error.message.includes('Failed to redirect to sign transaction')) {
          // Increase time to redirect to wallet before recording an error
          await new Promise(resolve => setTimeout(resolve, 10000))
        }
        if (typeof window !== 'undefined') urlParams.clear('locking')
        throw error
      }
    default: throw new Error(`Don't know how to act on transfer: ${JSON.stringify(transfer)}`)
  }
}

export async function checkStatus (transfer: Transfer): Promise<Transfer> {
  switch (transfer.completedStep) {
    case null: return await checkLock(transfer)
    default: throw new Error(`Don't know how to checkStatus for transfer ${transfer.id}`)
  }
}

/**
 * Find all transfers sending nep141Address tokens from NEAR to Aurora.
 * Any WAMP library can be used to query the indexer or NEAR explorer backend via the `callIndexer` callback.
 * Unlike with the rainbow bridge transfers, we must get the transfer info from transaction arguments instead of a
 * receipt id so the query must be made per token with the `nep141Address` argument.
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.fromBlock NEAR block timestamp.
 * @param params.toBlock 'latest' | NEAR block timestamp.
 * @param params.sender NEAR account id.
 * @param params.nep141Address Token address on NEAR.
 * @param params.callIndexer Function making the query to indexer.
 * @param params.options Optional arguments.
 * @param params.options.auroraEvmAccount Aurora account on NEAR.
 * @returns Array of NEAR transaction hashes.
 */
export async function findAllTransfers (
  { fromBlock, toBlock, sender, nep141Address, callIndexer, options }: {
    fromBlock: string
    toBlock: string
    sender: string
    nep141Address: string
    callIndexer: (query: string) => Promise<[{
      originated_from_transaction_hash: string
      args: { method_name: string, args_json: { msg: string, amount: string, receiver_id: string } }
    }]>
    options?: {
      auroraEvmAccount?: string
      nearAccount?: Account
      decimals?: number
      symbol?: string
    }
  }
): Promise<Transfer[]> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const auroraEvmAccount = options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount
  const nearAccount = options.nearAccount ?? await getNearAccount()
  const transactions = await callIndexer(buildIndexerTxQuery(
    { fromBlock, toBlock, predecessorAccountId: sender, receiverAccountId: nep141Address }
  ))
  const regex = nep141Address === auroraEvmAccount ? new RegExp(`^${sender}:${'0'.repeat(64)}[a-f0-9]{40}$`) : /^[a-f0-9]{40}$/
  // TODO also use getMetadata for aurora (nETH) when available
  let metadata = { symbol: '', decimals: 0 }
  if (nep141Address === auroraEvmAccount) {
    metadata = { decimals: 18, symbol: 'ETH' }
  } else if (!options.symbol || !options.decimals) {
    metadata = await getMetadata({ nep141Address, options })
  }
  const symbol = options.symbol ?? metadata.symbol
  const decimals = options.decimals ?? metadata.decimals
  const transfers = await Promise.all(transactions
    .filter(tx => tx.args.method_name === 'ft_transfer_call')
    .filter(tx => tx.args.args_json.receiver_id === auroraEvmAccount && regex.test(tx.args.args_json.msg))
    .map(async (tx): Promise<null | Transfer> => {
      const lockTx = await nearAccount.connection.provider.txStatus(
        tx.originated_from_transaction_hash, sender
      )
      let successValue
      try {
        // If the successValue equals the amount we know the transfer was successful
        // @ts-expect-error TODO
        successValue = Buffer.from(lockTx.status.SuccessValue, 'base64').toString()
        successValue = successValue.slice(1, successValue.length - 1)
      } catch (e) {
        console.log('Found a failed transaction: ', e)
        successValue = '0'
      }
      // @ts-expect-error TODO
      const txBlock = await nearAccount.connection.provider.block({ blockId: lockTx.transaction_outcome.block_hash })
      const amount = tx.args.args_json.amount.toString()
      const msg = tx.args.args_json.msg
      const recipient = nep141Address === auroraEvmAccount ? '0x' + msg.slice(msg.length - 40) : '0x' + msg
      if (amount !== successValue) return null
      return {
        type: TRANSFER_TYPE,
        id: Math.random().toString().slice(2),
        startTime: new Date(txBlock.header.timestamp / 10 ** 6).toISOString(),
        amount,
        decimals,
        symbol,
        sourceToken: nep141Address,
        sourceTokenName: metadata.symbol,
        destinationTokenName: 'a' + metadata.symbol,
        sender,
        recipient,
        status: status.COMPLETE,
        completedStep: LOCK,
        errors: [],
        lockHashes: [tx.originated_from_transaction_hash]
      }
    }))
  return transfers.filter((transfer: Transfer | null): transfer is Transfer => transfer !== null)
}

export async function recover (
  lockTxHash: string,
  callIndexer: (query: string) => Promise<[{
    included_in_block_timestamp: string
    receipt_predecessor_account_id: string
    args: { method_name: string, args_json: { msg: string, amount: string, sender_id: string } }
  }]>,
  options?: {
    nearAccount?: Account
    decimals?: number
    symbol?: string
    auroraEvmAccount?: string
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const auroraEvmAccount: string = options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount
  const actionReceipts = await callIndexer(`SELECT public.receipts.included_in_block_timestamp,
    public.action_receipt_actions.receipt_predecessor_account_id, public.action_receipt_actions.args
    FROM public.receipts
    JOIN public.action_receipt_actions
    ON public.action_receipt_actions.receipt_id = public.receipts.receipt_id
    WHERE (originated_from_transaction_hash = '${lockTxHash}'
      AND receiver_account_id = '${auroraEvmAccount}'
    )`
  )
  const [lockToAuroraActionReceipt] = actionReceipts.filter(
    // When sending nETH, msg = near_sender:eth_addr
    // When sending other nep141, msg = eth_addr
    r => r.args.method_name === 'ft_on_transfer' && /^[a-f0-9]{40}$/.test(r.args.args_json.msg.slice(r.args.args_json.msg.length - 40))
  )
  if (!lockToAuroraActionReceipt) {
    throw new Error(`Failed to verify ${auroraEvmAccount} ft_on_transfer action receipt: ${JSON.stringify(actionReceipts)}`)
  }
  const nep141Address = lockToAuroraActionReceipt.receipt_predecessor_account_id
  let metadata = { symbol: '', decimals: 0 }
  if (nep141Address === auroraEvmAccount) {
    metadata = { decimals: 18, symbol: 'ETH' }
  } else if (!options.symbol || !options.decimals) {
    metadata = await getMetadata({ nep141Address, options })
  }
  const symbol = options.symbol ?? metadata.symbol
  const decimals = options.decimals ?? metadata.decimals
  let sender = lockToAuroraActionReceipt.args.args_json.sender_id
  if (sender === auroraEvmAccount) {
    const msg = lockToAuroraActionReceipt.args.args_json.msg
    sender = msg.substr(0, msg.indexOf(':'))
  }
  return {
    type: TRANSFER_TYPE,
    id: Math.random().toString().slice(2),
    startTime: new Date(Number(lockToAuroraActionReceipt.included_in_block_timestamp) / 10 ** 6).toISOString(),
    amount: lockToAuroraActionReceipt.args.args_json.amount,
    decimals,
    symbol,
    sourceToken: nep141Address,
    sourceTokenName: metadata.symbol,
    destinationTokenName: 'a' + metadata.symbol,
    sender,
    recipient: '0x' + lockToAuroraActionReceipt.args.args_json.msg.slice(lockToAuroraActionReceipt.args.args_json.msg.length - 40),
    status: status.COMPLETE,
    completedStep: LOCK,
    errors: [],
    lockHashes: [lockTxHash]
  }
}

export async function checkLock (
  transfer: Transfer,
  options?: {
    nearAccount?: Account
  }
): Promise<Transfer> {
  options = options ?? {}
  const id = urlParams.get('locking') as string
  const txHash = urlParams.get('transactionHashes') as string | null
  const errorCode = urlParams.get('errorCode') as string | null
  const clearParams = ['locking', 'transactionHashes', 'errorCode', 'errorMessage']
  if (!id) {
    // The user closed the tab and never rejected or approved the tx from Near wallet.
    // This doesn't protect against the user broadcasting a tx and closing the tab before
    // redirect. So the dapp has no way of knowing the status of that transaction.
    const newError = 'Failed to process NEAR Wallet transaction.'
    console.error(newError)
    return {
      ...transfer,
      status: status.FAILED,
      errors: [newError]
    }
  }
  if (id !== transfer.id) {
    const newError = `Couldn't determine transaction outcome.
      Got transfer id '${id} in URL, expected '${transfer.id}`
    console.error(newError)
    return { ...transfer, status: status.FAILED, errors: [`Failed: ${newError}`] }
  }
  if (errorCode) {
    urlParams.clear(...clearParams)
    return { ...transfer, status: status.FAILED, errors: [`Failed: ${errorCode}`] }
  }
  if (!txHash) {
    console.log('Waiting for Near wallet redirect to sign lock')
    return transfer
  }
  const nearAccount = options.nearAccount ?? await getNearAccount()
  const decodedTxHash = utils.serialize.base_decode(txHash)
  const withdrawTx = await nearAccount.connection.provider.txStatus(
    // use transfer.sender instead of nearAccount.accountId so that a withdraw
    // tx hash can be recovered even if it is not made by the logged in account
    decodedTxHash, transfer.sender
  )

  // @ts-expect-error TODO
  const txBlock = await nearAccount.connection.provider.block({ blockId: withdrawTx.transaction_outcome.block_hash })
  const startTime = new Date(txBlock.header.timestamp / 10 ** 6).toISOString()

  urlParams.clear(...clearParams)
  return {
    ...transfer,
    status: status.COMPLETE,
    completedStep: LOCK,
    startTime,
    lockHashes: [...transfer.lockHashes, txHash]
  }
}

export async function sendToAurora (
  { nep141Address, amount, recipient, options }: {
    nep141Address: string
    amount: string | ethers.BigNumber
    recipient: string
    options?: {
      symbol?: string
      decimals?: number
      sender?: string
      nearAccount?: Account
      auroraEvmAccount?: string
    }
  }
): Promise<Transfer> {
  options = options ?? {}
  let metadata = { symbol: '', decimals: 0 }
  if (!options.symbol || !options.decimals) {
    metadata = await getMetadata({ nep141Address, options })
  }
  const symbol: string = options.symbol ?? metadata.symbol
  const sourceTokenName = symbol
  const destinationTokenName = 'a' + symbol
  const decimals = options.decimals ?? metadata.decimals
  const sourceToken = nep141Address
  const nearAccount = options.nearAccount ?? await getNearAccount()
  const sender = options.sender ?? nearAccount.accountId

  let transfer = {
    ...transferDraft,
    id: Math.random().toString().slice(2),
    startTime: new Date().toISOString(),
    amount: amount.toString(),
    decimals,
    symbol,
    sourceToken,
    sourceTokenName,
    destinationTokenName,
    sender,
    recipient
  }
  try {
    transfer = await lock(transfer, options)
  } catch (error) {
    if (error.message.includes('Failed to redirect to sign transaction')) {
      // Increase time to redirect to wallet before alerting an error
      await new Promise(resolve => setTimeout(resolve, 10000))
    }
    if (typeof window !== 'undefined' && urlParams.get('locking')) {
      // If the urlParam is set then the transfer was tracked so delete it.
      await untrack(urlParams.get('locking') as string)
      urlParams.clear('locking')
    }
    // Throw the error to be handled by frontend
    throw error
  }
  return transfer
}

export async function lock (
  transfer: Transfer,
  options?: {
    nearAccount?: Account
    auroraEvmAccount?: string
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const nearAccount = options.nearAccount ?? await getNearAccount()
  const auroraEvmAccount = options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount

  // nETH (aurora) transfers to Aurora have a different protocol:
  // <relayer_id>:<fee(32 bytes)><eth_address_receiver(20 bytes)>
  const msgPrefix = transfer.sourceToken === auroraEvmAccount ? transfer.sender + ':' + '0'.repeat(64) : ''

  // NOTE:
  // checkStatus should wait for NEAR wallet redirect if it didn't happen yet.
  // On page load the dapp should clear urlParams if transactionHashes or errorCode are not present:
  // this will allow checkStatus to handle the transfer as failed because the NEAR transaction could not be processed.
  if (typeof window !== 'undefined') urlParams.set({ locking: transfer.id })
  if (typeof window !== 'undefined') transfer = await track({ ...transfer, status: status.IN_PROGRESS }) as Transfer

  // If function call error, the transfer will be pending until the transaction id is cleared
  // and the transfer is set to FAILED by checkStatus.
  const tx = await nearAccount.functionCall({
    contractId: transfer.sourceToken,
    methodName: 'ft_transfer_call',
    args: {
      receiver_id: auroraEvmAccount,
      amount: transfer.amount,
      memo: null,
      msg: msgPrefix + transfer.recipient.toLowerCase().slice(2)
    },
    gas: new BN('70' + '0'.repeat(12)),
    attachedDeposit: new BN('1')
  })
  return {
    ...transfer,
    lockHashes: [tx.transaction.hash]
  }
}

export async function wrapAndSendNearToAurora (
  { amount, recipient, options }: {
    amount: string | ethers.BigNumber
    recipient: string
    options?: {
      symbol?: string
      sender?: string
      nearAccount?: Account
      auroraEvmAccount?: string
      wNearNep141?: string
    }
  }
): Promise<Transfer> {
  options = options ?? {}
  const symbol = options.symbol ?? 'NEAR'
  const destinationTokenName = 'a' + symbol
  const sourceTokenName = symbol
  const sourceToken = 'NEAR'
  const nearAccount = options.nearAccount ?? await getNearAccount()
  const sender = options.sender ?? nearAccount.accountId

  let transfer: Transfer = {
    ...transferDraft,
    id: Math.random().toString().slice(2),
    startTime: new Date().toISOString(),
    amount: amount.toString(),
    decimals: 24,
    symbol,
    sourceToken,
    sourceTokenName,
    destinationTokenName,
    sender,
    recipient
  }
  try {
    transfer = await lockNear(transfer, options)
  } catch (error) {
    if (error.message.includes('Failed to redirect to sign transaction')) {
      // Increase time to redirect to wallet before alerting an error
      await new Promise(resolve => setTimeout(resolve, 10000))
    }
    if (typeof window !== 'undefined' && urlParams.get('locking')) {
      // If the urlParam is set then the transfer was tracked so delete it.
      await untrack(urlParams.get('locking') as string)
      urlParams.clear('locking')
    }
    // Throw the error to be handled by frontend
    throw error
  }

  return transfer
}

export async function lockNear (
  transfer: Transfer,
  options?: {
    nearAccount?: Account
    auroraEvmAccount?: string
    wNearNep141?: string
  }
): Promise<Transfer> {
  options = options ?? {}
  const bridgeParams = getBridgeParams()
  const nearAccount = options.nearAccount ?? await getNearAccount()
  const wNearNep141 = options.wNearNep141 ?? bridgeParams.wNearNep141
  const auroraEvmAccount = options.auroraEvmAccount ?? bridgeParams.auroraEvmAccount

  const actions = []
  const minStorageBalance = await getMinStorageBalance({
    nep141Address: wNearNep141, nearAccount
  })
  const userStorageBalance = await getStorageBalance({
    nep141Address: wNearNep141,
    accountId: transfer.sender,
    nearAccount
  })
  if (!userStorageBalance || new BN(userStorageBalance.total).lt(new BN(minStorageBalance))) {
    actions.push(transactions.functionCall(
      'storage_deposit',
      Buffer.from(JSON.stringify({
        account_id: transfer.sender,
        registration_only: true
      })),
      new BN('50' + '0'.repeat(12)),
      new BN(minStorageBalance)
    ))
  }

  actions.push(transactions.functionCall(
    'near_deposit',
    Buffer.from(JSON.stringify({})),
    new BN('30' + '0'.repeat(12)),
    new BN(transfer.amount)
  ))
  actions.push(transactions.functionCall(
    'ft_transfer_call',
    Buffer.from(JSON.stringify({
      receiver_id: auroraEvmAccount,
      amount: transfer.amount,
      memo: null,
      msg: transfer.recipient.toLowerCase().slice(2)
    })),
    new BN('70' + '0'.repeat(12)),
    new BN('1')
  ))

  // NOTE:
  // checkStatus should wait for NEAR wallet redirect if it didn't happen yet.
  // On page load the dapp should clear urlParams if transactionHashes or errorCode are not present:
  // this will allow checkStatus to handle the transfer as failed because the NEAR transaction could not be processed.
  if (typeof window !== 'undefined') urlParams.set({ locking: transfer.id })
  if (typeof window !== 'undefined') transfer = await track({ ...transfer, status: status.IN_PROGRESS }) as Transfer

  // If function call error, the transfer will be pending until the transaction id is cleared
  // and the transfer is set to FAILED by checkStatus.
  // @ts-expect-error
  const tx = await nearAccount.signAndSendTransaction(wNearNep141, actions)
  return {
    ...transfer,
    lockHashes: [tx.transaction.hash]
  }
}

export async function getMinStorageBalance (
  { nep141Address, nearAccount }: {
    nep141Address: string
    nearAccount: Account
  }
): Promise<string> {
  try {
    const balance = await nearAccount.viewFunction(
      nep141Address,
      'storage_balance_bounds'
    )
    return balance.min
  } catch (e) {
    const balance = await nearAccount.viewFunction(
      nep141Address,
      'storage_minimum_balance'
    )
    return balance
  }
}

export async function getStorageBalance (
  { nep141Address, accountId, nearAccount }: {
    nep141Address: string
    accountId: string
    nearAccount: Account
  }
): Promise<null | {total: string}> {
  try {
    const balance = await nearAccount.viewFunction(
      nep141Address,
      'storage_balance_of',
      { account_id: accountId }
    )
    return balance
  } catch (e) {
    console.warn(e, nep141Address)
    return null
  }
}

const last = (arr: any[]): any => arr[arr.length - 1]
