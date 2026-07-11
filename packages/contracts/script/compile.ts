/**
 * Compiles the contracts with solc 0.8.24 (pinned, matches foundry.toml).
 * Both sources are self-contained (no external imports), so plain standard
 * JSON input is enough — no import resolution needed.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { Abi, Hex } from 'viem';

const require = createRequire(import.meta.url);
// justified-any: solc has no bundled TypeScript types
// eslint-disable-next-line
const solc: any = require('solc');

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

export interface CompiledContract {
  abi: Abi;
  bytecode: Hex;
}

export function compileAll(): Record<'LudoEscrow' | 'TestUSD', CompiledContract> {
  const input = {
    language: 'Solidity',
    sources: {
      'LudoEscrow.sol': { content: readFileSync(join(SRC_DIR, 'LudoEscrow.sol'), 'utf8') },
      'TestUSD.sol': { content: readFileSync(join(SRC_DIR, 'TestUSD.sol'), 'utf8') },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
    errors?: Array<{ severity: string; formattedMessage: string }>;
    contracts: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>>;
  };

  const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length > 0) {
    throw new Error('solc errors:\n' + errors.map((e) => e.formattedMessage).join('\n'));
  }

  const pick = (file: string, name: string): CompiledContract => {
    const c = output.contracts[file]?.[name];
    if (!c) throw new Error(`contract ${name} missing from solc output`);
    return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` as Hex };
  };

  return {
    LudoEscrow: pick('LudoEscrow.sol', 'LudoEscrow'),
    TestUSD: pick('TestUSD.sol', 'TestUSD'),
  };
}
