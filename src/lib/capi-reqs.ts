import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Increment user's consumed tokens in `CAPI_REQS` field (in `chameleons` table).
 * CAPI_REQS tracks the cumulative real token usage (Prompt + Completion)
 * for every AI interaction (Marline chat, Quiz generation, Summarization, etc.).
 */
export async function incrementUserConsumedTokens(authId: string, tokens: number): Promise<void> {
  if (!authId || !tokens || tokens <= 0) return;
  const tokensToAdd = Math.round(tokens);

  try {
    const supabaseAdmin = createAdminClient() as any;

    // Fetch current CAPI_REQS
    const { data: user, error: selectErr } = await supabaseAdmin
      .from('chameleons')
      .select('CAPI_REQS')
      .eq('auth_id', authId)
      .single();

    let currentVal = 0;
    if (!selectErr && user && user.CAPI_REQS !== undefined && user.CAPI_REQS !== null) {
      currentVal = Number(user.CAPI_REQS) || 0;
    } else {
      const { data: userQuoted } = await supabaseAdmin
        .from('chameleons')
        .select('"CAPI_REQS"')
        .eq('auth_id', authId)
        .single();
      if (userQuoted && userQuoted.CAPI_REQS !== undefined && userQuoted.CAPI_REQS !== null) {
        currentVal = Number(userQuoted.CAPI_REQS) || 0;
      }
    }

    const updatedVal = currentVal + tokensToAdd;

    const { error: updateErr } = await supabaseAdmin
      .from('chameleons')
      .update({ CAPI_REQS: updatedVal })
      .eq('auth_id', authId);

    if (updateErr) {
      console.warn('[CAPI_REQS] Error updating CAPI_REQS without quotes, trying fallback:', updateErr.message);
      await supabaseAdmin
        .from('chameleons')
        .update({ '"CAPI_REQS"': updatedVal })
        .eq('auth_id', authId);
    }

    console.log(`[CAPI_REQS] Successfully added ${tokensToAdd} consumed tokens to user ${authId} (New Total: ${updatedVal})`);
  } catch (err) {
    console.warn('[CAPI_REQS] Failed to update consumed tokens for user:', authId, err);
  }
}
