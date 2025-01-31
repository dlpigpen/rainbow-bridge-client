import { Account } from 'near-api-js'
import { serialize as serializeBorsh } from 'near-api-js/lib/utils/serialize'

export const EXIT_TO_NEAR_SIGNATURE = '0x5a91b8bc9c1981673db8fb226dbd8fcdd0c23f45cd28abb31403a5392f6dd0c7'
export const EXIT_TO_ETHEREUM_SIGNATURE = '0xd046c2bb01a5622bc4b9696332391d87491373762eeac0831c48400e2d5a5f07'
export const BURN_SIGNATURE = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export async function getErc20FromNep141 (
  { nep141Address, nearAccount, auroraEvmAccount }: {
    nep141Address: string
    nearAccount: Account
    auroraEvmAccount: string
  }
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class BorshArgs {
    constructor (args: any) {
      Object.assign(this, args)
    }
  };
  const schema = new Map([
    [BorshArgs, {
      kind: 'struct',
      fields: [
        ['nep141', 'String']
      ]
    }]
  ])
  const args = new BorshArgs({
    nep141: nep141Address
  })
  const serializedArgs = serializeBorsh(schema, args)
  const address: string = await nearAccount.viewFunction(
    auroraEvmAccount,
    'get_erc20_from_nep141',
    Buffer.from(serializedArgs),
    { parse: (result) => Buffer.from(result).toString('hex'), stringify: (args) => args }
  )
  return '0x' + address
}

export async function getNep141FromErc20 (
  { auroraErc20Address, nearAccount, auroraEvmAccount }: {
    auroraErc20Address: string
    nearAccount: Account
    auroraEvmAccount: string
  }
): Promise<string> {
  const address: string = await nearAccount.viewFunction(
    auroraEvmAccount,
    'get_nep141_from_erc20',
    Buffer.from(auroraErc20Address.toLowerCase().slice(2), 'hex'),
    { parse: (result) => Buffer.from(result).toString('utf-8'), stringify: (args) => args }
  )
  return address
}
