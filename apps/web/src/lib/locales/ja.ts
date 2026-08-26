import type { en } from './en.js';

/**
 * A translation catalogue: the same keys as English, but free-form strings.
 *
 * `en` is declared `as const`, so its values are literal types. Typing this file against
 * those literals would demand that every Japanese string equal its English original, which
 * is obviously wrong — the key set is what must match, not the text.
 */
export type Catalogue = Partial<Record<keyof typeof en, string>>;

/**
 * Japanese catalogue.
 *
 * Typed as a partial of the English catalogue: keys that are not yet translated fall back
 * to English at runtime rather than rendering blank, and adding a key to `en` never breaks
 * this file. The structure is complete for the navigation, authentication and compliance
 * vocabulary — the terms a Japanese-speaking reviewer meets first — and the remainder
 * falls back until it is translated.
 */
export const ja: Catalogue = {
  'app.promise': '検証済みの回答。正確な根拠。修正済みの文書。',
  'app.consultantRole': 'コンプライアンス・コンサルタント',
  'app.consultantAlt': 'コンプライアンス・コンサルタントのあゆみ',

  'nav.dashboard': 'ダッシュボード',
  'nav.consult': '相談する',
  'nav.knowledge': 'ナレッジベース',
  'nav.reports': 'レポート',
  'nav.activity': 'アクティビティ',
  'nav.users': 'ユーザー',
  'nav.settings': '設定',
  'nav.more': 'その他',
  'nav.platform': 'プラットフォーム',
  'nav.skipToContent': 'メインコンテンツへスキップ',
  'nav.mainLabel': 'メインナビゲーション',
  'nav.mobileLabel': '主要ナビゲーション',
  'settings.connectors': 'コネクタ',
  'knowledge.syncFrom': '{label} から同期',
  'knowledge.connectorNeedsSetup': '{label} はまだ設定されていません',
  'knowledge.connectorNeedsSetupHint': 'ファイルを取り込むには、管理者が接続する必要があります。',
  'knowledge.openSettings': '設定を開く',
  'connectors.title': '接続済みファイルストア',
  'connectors.description':
    'ドキュメントストアを接続すると、そのファイルは手動でアップロードしたものと同じように索引付け・引用・修正の対象になります。アクセスは読み取り専用です。',
  'connectors.connect': '接続',
  'connectors.disconnect': '切断',
  'connectors.syncNow': '今すぐ同期',
  'connectors.account': 'アカウント',
  'connectors.lastSync': '最終同期',
  'connectors.never': '未実行',
  'connectors.statusConnected': '接続済み',
  'connectors.statusNotConnected': '未接続',
  'connectors.statusNeedsSetup': '設定が必要',
  'connectors.statusError': '要確認',
  'connectors.connected': 'アカウントを接続しました。',
  'connectors.disconnected': 'アカウントを切断しました。取り込み済みの文書はそのまま残ります。',
  'connectors.cancelled': '接続をキャンセルしました。',
  'connectors.failed': '接続を完了できませんでした。',
  'connectors.connectFailed': '接続を開始できませんでした。',
  'connectors.syncStarted': '同期を開始しました。完了した文書からナレッジベースに表示されます。',
  'connectors.setupHint':
    'この環境にはまだこのプロバイダの OAuth アプリケーションがありません。運用者が登録し、次を設定する必要があります:',
  'connectors.redirectHint': '次のリダイレクト URI をプロバイダにそのまま登録してください:',
  'connectors.reasonNoRefresh':
    '長期の認可が返されなかったため、接続は 1 時間以内に失効します。もう一度試して同意画面を承認してください。',
  'connectors.reasonExpired': '時間切れです。接続をやり直してください。',
  'connectors.reasonNotConfigured':
    'この環境にはそのプロバイダの OAuth アプリケーションがありません。',
  'connectors.reasonGeneric': 'プロバイダとのハンドシェイクが完了しませんでした。',
  'auth.accountCreated': 'アカウントを作成しました',
  'auth.accountCreatedHint': 'ワークスペースの準備ができました。サインインしてください。',
  'auth.passwordHint': '{min} 文字以上、大文字・小文字・数字を含めてください。',
  'auth.passwordHintInvite': '{min} 文字以上で、他で使っていないものにしてください。',
  'auth.registeredNotice': 'アカウントを作成しました。サインインしてください。',

  'auth.welcomeBack': 'おかえりなさい',
  'auth.continueGoogle': 'Google で続行',
  'auth.continueMicrosoft': 'Microsoft で続行',
  'auth.or': 'または',
  'auth.workEmail': '会社のメールアドレス',
  'auth.password': 'パスワード',
  'auth.rememberMe': 'ログイン状態を保持する',
  'auth.forgotPassword': 'パスワードをお忘れですか？',
  'auth.signIn': 'サインイン',
  'auth.signOut': 'サインアウト',
  'auth.noAccount': 'アカウントをお持ちでない方',
  'auth.createAccount': 'アカウントを作成',
  'auth.enterpriseSecurity': 'エンタープライズ級のセキュリティ',
  'auth.enterpriseSecurityDetail': '文書は非公開のまま保護されます。',
  'auth.trustedBy': 'コンプライアンス部門に選ばれています',
  'auth.secureConfidential': '安全かつ機密',
  'auth.sessionExpired': 'セッションの有効期限が切れました。再度サインインしてください。',

  'compliance.compliant': '適合',
  'compliance.nonCompliant': '不適合',
  'compliance.needsEvidence': '根拠が必要',
  'compliance.notAssessed': '未評価',
  'compliance.partiallyCompliant': '部分的に適合',
  'compliance.unableToDetermine': '判断できません',
  'compliance.yes': 'はい',
  'compliance.no': 'いいえ',
  'compliance.sourcesVerified': '出典を検証済み',
  'compliance.groundedAnswer': '根拠に基づく回答',

  'consult.title': '今すぐ相談',
  'consult.newConsultation': '新しい相談',
  'consult.ask': '質問',
  'consult.summarize': '要約',
  'consult.checkCompliance': '適合性を確認',
  'consult.correctDocument': '文書を修正',
  'consult.answerStyle': '回答スタイル',
  'consult.styleYesNo': 'はい / いいえ',
  'consult.styleOptimal': '最適',
  'consult.styleDetails': '詳細と参照',
  'consult.evidenceCoverage': '根拠のカバレッジ',
  'consult.knowledgeOnly': 'ナレッジのみ',
  'consult.openExactPage': '該当ページを開く',

  'knowledge.title': 'ナレッジベース',
  'knowledge.subtitle': '根拠に基づく回答のための承認済みソース',
  'knowledge.ready': '準備完了',
  'knowledge.processing': '処理中',
  'knowledge.needsReview': '要確認',
  'knowledge.failed': '失敗',

  'common.search': '検索',
  'common.cancel': 'キャンセル',
  'common.edit': '編集',
  'common.delete': '削除',
  'common.save': '保存',
  'common.close': '閉じる',
  'common.retry': '再試行',
  'common.loading': '読み込み中',
};
