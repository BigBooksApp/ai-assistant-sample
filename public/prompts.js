// The suggested prompts the empty state samples from — questions about the signed-in
// party's own books, which is what the assistant's tools can actually answer. Editing
// this list is the whole of "customising the empty state"; nothing else reads it.

export const PROMPTS = [
  'What changed this month?',
  'Why did my spending increase?',
  'Find subscriptions I don\'t use.',
  'How can I save $500/month?',
  'Which investments are hurting my returns?',
  'Am I making financial mistakes?',
  'Summarize my finances in five bullet points.',
  'Predict whether I\'ll have enough cash next quarter.',
  'Where did my money go last month?',
  'What am I spending on food each week?',
  'Which category grew the most this year?',
  'Am I spending more than I earn?',
  'What\'s my biggest recurring expense?',
  'Show me my top five expenses this month.',
  'How does this month compare to last month?',
  'Is my net worth going up or down?',
  'What did I spend on Amazon this year?',
  'Find transactions that look like duplicates.',
  'Which bills went up recently?',
  'How much do my subscriptions cost per year?',
  'What\'s my average monthly spending?',
  'How much did I pay in fees and interest this year?',
  'Am I on track with my budget?',
  'Where am I over budget this month?',
  'What can I cut to save money?',
  'How much cash will I have at the end of the month?',
  'When will I hit $10,000 in savings?',
  'How long would my savings last if I lost my income?',
  'Find any unusual transactions this month.',
  'Did I get charged twice for anything?',
  'What\'s my debt costing me each month?',
  'How fast am I paying down my debt?',
  'What percentage of my income goes to housing?',
  'How much did I save this year compared to last year?',
  'Which merchant gets the most of my money?',
  'What should I look at in my finances this week?',
];

/** 36 prompts in, `count` distinct ones out, in random order (Fisher-Yates on a copy). */
export function samplePrompts(count) {
  const pool = PROMPTS.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length));
}
