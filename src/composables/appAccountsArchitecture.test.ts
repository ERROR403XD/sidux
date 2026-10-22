import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../App.vue', import.meta.url), 'utf8').split('<script setup lang="ts">')[1]!.split('</script>')[0]!
const source = ts.createSourceFile('App.ts', app, ts.ScriptTarget.Latest, true)
const privateNames = new Set(['removedAccountIds', 'accountStateRevision', 'accountActionsStopped', 'accountReadFlight', 'accountOverviewPollTimer', 'accountStatePollTimer', 'isAccountStatePollInFlight', 'externalAuthImportAttempted', 'hasAccountSnapshot'])

describe('App account ownership boundary', () => {
  it('keeps account mutation APIs, private resources and policy functions out of the shell', () => {
    const violations: string[] = []
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /accountGateway|useAccountQuotaUpdates/.test(node.moduleSpecifier.text)) violations.push(node.moduleSpecifier.text)
      if (ts.isVariableDeclaration(node) && privateNames.has(node.name.getText(source))) violations.push(node.name.getText(source))
      if (ts.isFunctionDeclaration(node) && /^(?:applyAccountsSnapshot|onSwitchAccount|onRemoveAccount|onAccountLoginCompleted|loadAccountsState|maybeImportExternalCodexAuthAccount|captureAccountAction)$/.test(node.name?.text || '')) violations.push(node.name!.text)
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('exposes account projections to App without permitting shell writes', () => {
    const violations: string[] = []
    const projections = new Set(['accounts', 'directoryAccountRevision', 'isSwitchingAccounts', 'isCodexLoginModalOpen', 'loginTargetStorageId', 'confirmingRemoveAccountId', 'accountActionError'])
    function visit(node: ts.Node) {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        let left = node.left
        while (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) left = left.expression
        if (projections.has(left.getText(source))) violations.push(node.left.getText(source))
      }
      if (ts.isVariableDeclaration(node) && projections.has(node.name.getText(source))) violations.push(node.name.getText(source))
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('keeps the account owner independent of the App and desktop implementation', () => {
    const owner = ts.createSourceFile('accounts.ts', readFileSync(new URL('appAccountsController.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
    const imports = owner.statements.filter(ts.isImportDeclaration).map(node => node.moduleSpecifier.getText(owner))
    expect(imports.filter(path => /App\.vue|useDesktopState|\/api(?:['"]|\.ts)/.test(path))).toEqual([])
    const transport = readFileSync(new URL('useAccountQuotaUpdates.ts', import.meta.url), 'utf8')
    expect(transport).not.toMatch(/accounts\.value|onBeforeUnmount|onMounted/)
  })
})
