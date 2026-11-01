import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
const root = process.env.W98_CARD_TREE ?? process.cwd();
const filename = resolve(root, 'src/components/RequestCard/index.tsx');
const text = readFileSync(filename, 'utf8');
const sf = ts.createSourceFile(
  filename,
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
const roles = [];
const cls = (n) => {
  const a = n.openingElement.attributes.properties.find(
    (a) => a.name?.text === 'className'
  );
  return a?.initializer && ts.isStringLiteral(a.initializer)
    ? a.initializer.text
    : '';
};
function walk(n) {
  if (
    ts.isJsxElement(n) &&
    n.openingElement.attributes.properties.some(
      (a) => a.name?.text === 'role' && a.initializer?.text === 'status'
    )
  )
    roles.push(n);
  ts.forEachChild(n, walk);
}
walk(sf);
assert.equal(roles.length, 2, 'both actual card branches must retain guidance');
const helper = ts.transpileModule(
  readFileSync(
    resolve(process.cwd(), 'src/components/RequestList/intentStatus.ts'),
    'utf8'
  ),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } }
).outputText;
const out = {};
new Function('exports', helper)(out);
const receipts = [];
for (const [branch, role] of roles.entries()) {
  for (const state of ['accepted_pending', 'unknown']) {
    test(`actual card branch ${branch} ${state} SSR guidance has no hidden ancestor`, () => {
      let ancestors = [],
        n = role.parent;
      while (n && !ts.isArrowFunction(n) && !ts.isFunctionDeclaration(n)) {
        if (ts.isJsxElement(n)) ancestors.push(cls(n));
        n = n.parent;
      }
      assert.ok(
        !ancestors.some((c) => c.split(/\s+/).includes('hidden')),
        'mobile guidance must not inherit the responsive-hidden label'
      );
      const jsx = ts.transpileModule(
        'const render = () => (' + role.getText(sf) + ');',
        {
          compilerOptions: {
            jsx: ts.JsxEmit.React,
            module: ts.ModuleKind.CommonJS,
          },
        }
      ).outputText;
      const render = new Function(
        'React',
        'requestData',
        'MediaStatus',
        'bookIntentStatus',
        jsx + ';return render;'
      )(
        React,
        { bookRequestIntentState: state, is4k: false, media: { status: 3 } },
        { AVAILABLE: 5 },
        out.bookIntentStatus
      );
      const markup = renderToStaticMarkup(React.createElement(render));
      assert.match(markup, /role="status"/);
      assert.ok(markup.includes(out.bookIntentStatus(state)));
      receipts.push({
        branch,
        state,
        markup,
        ancestorClasses: ancestors,
        scope:
          'actual status JSX rendered by React SSR; no browser/viewport/CSS acceptance claim',
      });
    });
  }
}
test.after(() => {
  if (process.env.W98_CARD_RECEIPT)
    writeFileSync(
      process.env.W98_CARD_RECEIPT,
      JSON.stringify(receipts, null, 2)
    );
});
