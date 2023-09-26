import vscode from "vscode"

import * as csv from "csv/sync";
import * as html from "./html";

import { getInstance } from "../../base";
import { JobManager } from "../../config";
import { Query, QueryState } from "../../connection/query";
import { updateStatusBar } from "../jobManager/statusBar";
import Document from "../../language/sql/document";
import { changedCache } from "../../language/providers/completionItemCache";
import { ObjectRef, StatementType } from "../../language/sql/types";

function delay(t: number, v?: number) {
  return new Promise(resolve => setTimeout(resolve, t, v));
}

class ResultSetPanelProvider {
  _view: vscode.WebviewView;
  loadingState: boolean;
  constructor() {
    this._view = undefined;
    this.loadingState = false;
  }

  resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken) {
    this._view = webviewView;

    webviewView.webview.options = {
      // Allow scripts in the webview
      enableScripts: true,
    };

    webviewView.webview.html = html.getLoadingHTML();
    this._view.webview.onDidReceiveMessage(async (message) => {
      if (message.query) {
        let data = [];

        let queryObject = Query.byId(message.queryId);
        try {
          if (queryObject === undefined) {
            // We will need to revisit this if we ever allow multiple result tabs like ACS does
            Query.cleanup();

            let query = await JobManager.getPagingStatement(message.query, { isClCommand: message.isCL, autoClose: true, isTerseResults: true });
            queryObject = query;
          }

          let queryResults = queryObject.getState() == QueryState.RUN_MORE_DATA_AVAILABLE ? await queryObject.fetchMore() : await queryObject.run();
          data = queryResults.data;
          this._view.webview.postMessage({
            command: `rows`,
            rows: queryResults.data,
            columnList: queryResults.metadata ? queryResults.metadata.columns.map(x=>x.name) : undefined, // Query.fetchMore() doesn't return the metadata
            queryId: queryObject.getId(),
            update_count: queryResults.update_count,
            isDone: queryResults.is_done
          });

        } catch (e) {
          this.setError(e.message);
          this._view.webview.postMessage({
            command: `rows`,
            rows: [],
            queryId: ``,
            isDone: true
          });
        }

        updateStatusBar();
      }
    });
  }

  async ensureActivation() {
    let currentLoop = 0;
    while (!this._view && currentLoop < 15) {
      await this.focus();
      await delay(100);
      currentLoop += 1;
    }
  }

  async focus() {
    if (!this._view) {
      // Weird one. Kind of a hack. _view.show doesn't work yet because it's not initialized.
      // But, we can call a VS Code API to focus on the tab, which then
      // 1. calls resolveWebviewView
      // 2. sets this._view
      await vscode.commands.executeCommand(`vscode-db2i.resultset.focus`);
    } else {
      this._view.show(true);
    }
  }

  async setLoadingText(content) {
    await this.focus();

    if (!this.loadingState) {
      this._view.webview.html = html.getLoadingHTML();
      this.loadingState = true;
    }

    html.setLoadingText(this._view.webview, content);
  }

  async setScrolling(basicSelect, isCL = false) {
    await this.focus();

    this._view.webview.html = html.generateScroller(basicSelect, isCL);

    this._view.webview.postMessage({
      command: `fetch`,
      queryId: ``
    });
  }

  setError(error) {
    // TODO: pretty error
    this._view.webview.html = `<p>${error}</p>`;
  }
}

export type StatementQualifier = "statement"|"json"|"csv"|"cl"|"sql";

export interface StatementInfo {
  content: string,
  qualifier: StatementQualifier,
  open?: boolean,
  history?: boolean,
  type?: StatementType,
  refs?: ObjectRef[]
}

export function initialise(context: vscode.ExtensionContext) {
  let resultSetProvider = new ResultSetPanelProvider();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(`vscode-db2i.resultset`, resultSetProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand(`vscode-db2i.runEditorStatement`,
      async (options: StatementInfo) => {
        // Options here can be a vscode.Uri when called from editor context.
        // But that isn't valid here.
        const optionsIsValid = (options && options.content !== undefined);

        const instance = getInstance();
        const config = instance.getConfig();
        const content = instance.getContent();
        const editor = vscode.window.activeTextEditor;

        if (optionsIsValid || (editor && editor.document.languageId === `sql`)) {
          await resultSetProvider.ensureActivation();

          /** @type {StatementInfo} */
          const statement = (optionsIsValid ? options : parseStatement(editor));

          if (statement.open) {
            const textDoc = await vscode.workspace.openTextDocument({ language: `sql`, content: statement.content });
            await vscode.window.showTextDocument(textDoc);
          }

          statementMiddleware(statement);

          if (statement.content.trim().length > 0) {
            try {
              if (statement.qualifier === `cl`) {
                resultSetProvider.setScrolling(statement.content, true);
              } else {
                if (statement.qualifier === `statement`) {
                  // If it's a basic statement, we can let it scroll!
                  resultSetProvider.setScrolling(statement.content);

                } else {
                  // Otherwise... it's a bit complicated.
                  const data = await JobManager.runSQL(statement.content, undefined);

                  if (data.length > 0) {
                    switch (statement.qualifier) {

                    case `csv`:
                    case `json`:
                    case `sql`:
                      let content = ``;
                      switch (statement.qualifier) {
                      case `csv`: content = csv.stringify(data, {
                        header: true,
                        quoted_string: true,
                      }); break;
                      case `json`: content = JSON.stringify(data, null, 2); break;

                      case `sql`:
                        const keys = Object.keys(data[0]);

                        const insertStatement = [
                          `insert into TABLE (`,
                          `  ${keys.join(`, `)}`,
                          `) values `,
                          data.map(
                            row => `  (${keys.map(key => {
                              if (row[key] === null) return `null`;
                              if (typeof row[key] === `string`) return `'${String(row[key]).replace(/'/g, `''`)}'`;
                              return row[key];
                            }).join(`, `)})`
                          ).join(`,\n`),
                        ];
                        content = insertStatement.join(`\n`);
                        break;
                      }

                      const textDoc = await vscode.workspace.openTextDocument({ language: statement.qualifier, content });
                      await vscode.window.showTextDocument(textDoc);
                      break;
                    }

                  } else {
                    vscode.window.showInformationMessage(`Query executed with no data returned.`);
                  }
                }
              }

              if (statement.qualifier === `statement`) {
                vscode.commands.executeCommand(`vscode-db2i.queryHistory.prepend`, statement.content);
              }

            } catch (e) {
              let errorText;
              if (typeof e === `string`) {
                errorText = e.length > 0 ? e : `An error occurred when executing the statement.`;
              } else {
                errorText = e.message || `Error running SQL statement.`;
              }

              if (statement.qualifier === `statement` && statement.history !== false) {
                resultSetProvider.setError(errorText);
              } else {
                vscode.window.showErrorMessage(errorText);
              }
            }
          }
        }
      }),
  )
}

export function statementMiddleware(statement: StatementInfo) {
  switch (statement.type) {

    case StatementType.Create:
    case StatementType.Alter:
      const ref = statement.refs[0];
      const databaseObj =
        statement.type === StatementType.Create && ref.createType.toUpperCase() === `schema`
          ? ref.object.schema || ``
          : ref.object.schema + ref.object.name;
      changedCache.add((databaseObj || ``).toUpperCase());
      break;

    case StatementType.Set:
      const selected = JobManager.getSelection();
      if (selected) {
        // SET -CURRENT- X -=- Y
        let setterIndex = 1;

        const sqlDocument = new Document(statement.content);
        const setStatement = sqlDocument.getStatementGroups()[0].statements[0];

        if (setStatement.tokens[1].value.toUpperCase() === `CURRENT`) {
          setterIndex += 1;
        }

        let valueIndex = setterIndex + 1;

        if (setStatement.tokens[valueIndex].type === `equal`) {
          valueIndex += 1;
        }

        const variableValue = setStatement.tokens[setterIndex].value;
        const setterValue = setStatement.tokens[valueIndex].value;

        if (variableValue && setterValue) {
          switch (variableValue.toUpperCase()) {
            case `SCHEMA`:
              selected.job.options.libraries[0] = variableValue;
              break;
          }
        }
      }
      break;
  }
}

export function parseStatement(editor: vscode.TextEditor): StatementInfo {
  const document = editor.document;

  let text = document.getText(editor.selection).trim();
  let content = ``;
  let statementType: StatementType|undefined;
  let statementRefs: ObjectRef[]|undefined;

  let qualifier: StatementQualifier = `statement`;

  if (text.length > 0) {
    content = text;
  } else {
    const cursor = editor.document.offsetAt(editor.selection.active);
    text = document.getText();

    const sqlDocument = new Document(text);
    const group = sqlDocument.getGroupByOffset(cursor);

    if (group) {
      if (group.statements[0]) {
        statementType = group.statements[0].type;
        statementRefs = group.statements[0].getObjectReferences();
      }

      content = text.substring(group.range.start, group.range.end);
      editor.selection = new vscode.Selection(editor.document.positionAt(group.range.start), editor.document.positionAt(group.range.end));
    }
  }

  if (content) {
    [`cl`, `json`, `csv`, `sql`].forEach(mode => {
      if (content.trim().toLowerCase().startsWith(mode + `:`)) {
        content = content.substring(mode.length + 1).trim();

        //@ts-ignore We know the type.
        qualifier = mode;
      }
    });
  }

  return {
    qualifier: qualifier,
    content,
    type: statementType,
    refs: statementRefs
  };
}