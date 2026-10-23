// The YouTube subscription badge (lib/youtube-subscriptions.ts) the DJs table
// and the DJ page share: `YTS.badge(status, { channelUrl, reason, error,
// needsReconnect })` returns the badge's HTML. Red only when the owner has to
// act: YouTube not connected, or a grant Google refused (reconnect on Settings).

export const YT_SUB_JS = /* js */ `
const YTS = (() => {
  const esc = TK.esc;
  const REASONS = {
    no_set_meta: 'None of the DJ\\'s set pages has been read yet. Looked at again every hour.',
    no_artist_box: 'The set pages read so far have no artist box with the DJ\\'s name. Looked at again every hour.',
    no_youtube_link: '1001tracklists lists no YouTube channel for this DJ. Looked at again every hour.',
  };
  function badge(status, o) {
    o = o || {};
    const b = (cls, text, tip) => '<span class="badge ' + cls + '"' + TK.tip(tip) + '>' + esc(text) + '</span>';
    if (o.needsReconnect && (status === 'pending' || status === 'looking'))
      return b('bad', 'reconnect', 'YouTube is not connected, or Google refused the connection: reconnect YouTube on Settings. Subscriptions wait until then.');
    switch (status) {
      case 'subscribed': return b('ok', 'subscribed', 'Your YouTube account is subscribed to the DJ\\'s channel. tracked made this subscription and removes it when you remove the DJ.');
      case 'owner': return b('neutral', 'your own', 'You were subscribed to the DJ\\'s channel already. tracked never removes it.');
      case 'pending': return b('info', 'pending', 'Queued: a coming run subscribes to the DJ\\'s channel, at the YouTube subscriptions rank on the Quota page.' + (o.error ? ' Last try: ' + o.error : ''));
      case 'looking': return b('neutral', 'looking', 'The DJ\\'s YouTube channel has not been looked up yet. It is found from their set pages within the next runs.');
      case 'no_channel': return b('neutral', 'no channel', (REASONS[o.reason] || 'No YouTube channel is known for this DJ.') + ' Nothing is subscribed until one is.');
      case 'failed': return b('warn', 'failed', 'Subscribing failed five times and is not tried again until the channel changes.' + (o.error ? ' Last error: ' + o.error : ''));
      case 'not_found': return b('info', 'channel gone', 'YouTube does not know the channel 1001tracklists links. Tried again weekly.');
      case 'off': return b('neutral', 'off', 'YouTube subscriptions are switched off in Settings.');
      default: return '<span class="tkt-nil">-</span>';
    }
  }
  return { badge };
})();
`;
