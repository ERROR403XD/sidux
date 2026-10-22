import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const component = readFileSync(new URL('../components/content/ThreadConversation.vue', import.meta.url), 'utf8')
const script = component.split('<script setup lang="ts">')[1]!.split('</script>')[0]!
const source = ts.createSourceFile('conversation.ts', script, ts.ScriptTarget.Latest, true)
const ownerText = readFileSync(new URL('./conversationFileActionsController.ts', import.meta.url), 'utf8')
const owner = ts.createSourceFile('owner.ts', ownerText, ts.ScriptTarget.Latest, true)

describe('Conversation file action ownership', () => {
  it('keeps transport, mutable action state and identity watcher in the controller', () => {
    const violations: string[] = []
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node) && /threadCommandGateway/.test(node.moduleSpecifier.getText(source))) violations.push(node.getText(source))
      if (ts.isFunctionDeclaration(node) && /^(?:runFileChangeAction|resetFileChangeActions|fileChangeActionKey)$/.test(node.name?.text || '')) violations.push(node.name!.text)
      if (ts.isVariableDeclaration(node) && /^(?:fileChangeActionState|fileChangeActionError|fileChangeRedoPatchIds|fileChangePendingRedoPatchIds|fileChangeActionGeneration|fileChangeActionStopped)$/.test(node.name.getText(source))) violations.push(node.name.getText(source))
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
    expect(component).toContain('fileChangeActions.stop()')
    expect(readFileSync(new URL('../App.vue', import.meta.url), 'utf8')).toContain(':account-revision="directoryAccountRevision"')
  })

  it('has a narrow dependency boundary and no direct transport, timer or DOM work', () => {
    const imports = owner.statements.filter(ts.isImportDeclaration).map(node => node.moduleSpecifier.getText(owner))
    expect(imports).toEqual(["'vue'", "'../api/threadCommandGateway'"])
    expect(ownerText).not.toMatch(/\b(?:fetch|setTimeout|setInterval|window|document|UiMessage|App|useDesktopState)\b/)
    expect(ownerText).toContain("{ flush: 'sync' }")
    expect(ownerText).toContain('stopIdentityWatch()')
  })
})
