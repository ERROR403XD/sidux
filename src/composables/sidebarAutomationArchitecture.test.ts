import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const component = readFileSync(new URL('../components/sidebar/SidebarThreadTree.vue', import.meta.url), 'utf8')
const script = component.split('<script setup lang="ts">')[1]!.split('</script>')[0]!
const source = ts.createSourceFile('sidebar.ts', script, ts.ScriptTarget.Latest, true)
const owner = ts.createSourceFile('owner.ts', readFileSync(new URL('./sidebarAutomationController.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)

describe('Sidebar project and automation ownership', () => {
  it('keeps automation transport and business state out of the sidebar assembly', () => {
    const violations: string[] = []
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node) && /automationGateway|automationAccountModels/.test(node.moduleSpecifier.getText(source))) violations.push(node.getText(source))
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'fetch') violations.push(node.getText(source))
      if (ts.isFunctionDeclaration(node) && /^(?:submitAutomationDialog|onDeleteAutomationFromDialog|removeProjectAndAutomations|setAutomationMaps|reloadProjectAutomations)$/.test(node.name?.text || '')) violations.push(node.name!.text)
      if (ts.isVariableDeclaration(node) && /^(?:automationByThreadId|automationByProjectName|automationMapsRevision|accountModels|accountModelGeneration|removingAutomationProjects)$/.test(node.name.getText(source))) violations.push(node.name.getText(source))
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('uses commands for confirmation state and does not query a private menu class', () => {
    expect(component).not.toMatch(/projectRemoval\s*=|automationRemoval\s*=|querySelector[^\n]*project-menu-panel/)
    expect(component).toContain('handle.getPanelHeight()')
    expect(component).toContain('projectMenuHandleByName.clear()')
  })

  it('keeps the controller independent of view, shell and broad API facades', () => {
    const imports = owner.statements.filter(ts.isImportDeclaration).map(node => node.moduleSpecifier.getText(owner))
    expect(imports.filter(path => /App\.vue|SidebarThreadTree|useDesktopState|codexGateway|\/api(?:['"]|\.ts)/.test(path))).toEqual([])
    const directTransport: string[] = []
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(owner) === 'fetch') directTransport.push(node.getText(owner))
      ts.forEachChild(node, visit)
    }
    visit(owner)
    expect(directTransport).toEqual([])
  })
})
