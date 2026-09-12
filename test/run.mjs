/**
 * Run every verification suite and report one verdict each.
 *
 * The client and host suites are self-contained. The kernel suite validates the
 * append payloads against `dsh-session`'s real surface fold, so it needs a DSH
 * checkout plus tsx and is skipped when `DSH_CHECKOUT` is unset.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const suites = [
  { name: '客户端加载与勾选面板', file: 'client.smoke.mjs' },
  { name: '宿主盘点与写路径', file: 'host.smoke.mjs' },
  { name: '内核 surface 校验器', file: 'kernel.release.mjs', checkout: true },
]

let failed = 0
for (const suite of suites) {
  const args = []
  let cwd = here
  if (suite.checkout === true) {
    const checkout = process.env.DSH_CHECKOUT
    if (checkout === undefined) {
      console.log(`SKIP  ${suite.name}（未设 DSH_CHECKOUT）`)
      continue
    }
    args.push('--import', 'tsx/esm')
    cwd = checkout
  }
  console.log(`\n=== ${suite.name} ===`)
  const result = spawnSync(process.execPath, [...args, join(here, suite.file)], { stdio: 'inherit', cwd })
  if (result.status !== 0) {
    failed += 1
    console.log(`FAIL  ${suite.name}（exit ${String(result.status)}）`)
  } else {
    console.log(`PASS  ${suite.name}`)
  }
}

console.log(failed === 0 ? '\n全部套件通过' : `\n${failed} 个套件失败`)
process.exit(failed === 0 ? 0 : 1)
