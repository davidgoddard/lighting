// Detect a sustained final near-silent tail using *raw* short-time RMS, not
// normalised energy (which can turn recording hiss into apparent activity).
export function detectFinalSilence(rms, hopSeconds, duration) {
  if (!rms?.length || !Number.isFinite(hopSeconds) || hopSeconds <= 0) return null;
  const n = rms.length;
  const quantile = (arr, q) => { const v = [...arr].sort((a,b)=>a-b); return v[Math.floor((v.length-1)*q)] ?? 0; };
  const smoothRadius = Math.max(1, Math.round(.10 / hopSeconds));
  const smoothed = Array.from({length:n}, (_,i) => {
    let s=0,k=0;
    for(let j=Math.max(0,i-smoothRadius);j<=Math.min(n-1,i+smoothRadius);j++){s+=rms[j];k++;}
    return s/k;
  });
  // Use the late recording's musical level rather than global mastering level.
  const earlier = smoothed.slice(Math.max(0,n-Math.ceil(16/hopSeconds)),Math.max(0,n-Math.ceil(2/hopSeconds)));
  if (earlier.length < 5) return null;
  const active = quantile(earlier,.75);
  const nearFloor = quantile(smoothed,.08);
  if (active < 1e-5 || active < nearFloor*1.8) return null;
  const ceiling = Math.min(active*.24,nearFloor*2.0 + active*.025);
  // Require 0.45 seconds of low sound leading into the actual end. Allow up to
  // 0.2 seconds of trailing encoder artifacts or closing clicks.
  const required=Math.max(2,Math.ceil(.45/hopSeconds));
  const lastUsable=n-1-Math.ceil(.14/hopSeconds);
  if(lastUsable<required)return null;
  let quiet=0, start=null;
  for(let i=lastUsable;i>=Math.max(0,lastUsable-Math.ceil(9/hopSeconds));i--){
    if(smoothed[i]<ceiling){quiet++;start=i;}else break;
  }
  if(quiet<required)return null;
  const at=Math.max(0,(start*hopSeconds));
  return at <= duration-.35 ? +at.toFixed(3) : null;
}


// Find a sharp *final* reduction in recorded RMS, even when surface hiss or
// mastering noise makes the ending too loud for a strict silence detector.
// Only a drop with a quiet suffix is eligible; isolated earlier pauses aren't.
export function detectTerminalCollapse(rms, hopSeconds, duration) {
  if (!rms?.length || !Number.isFinite(hopSeconds) || hopSeconds <= 0) return null;
  const n=rms.length;
  const window=Math.max(2,Math.round(.22/hopSeconds));
  const average=(a,b)=>{let sum=0,k=0;for(let i=Math.max(0,a);i<Math.min(n,b);i++){sum+=rms[i];k++;}return k?sum/k:0;};
  const latest=n-1-Math.ceil(.22/hopSeconds);
  const first=Math.max(window*2, Math.floor((duration-3.5)/hopSeconds));
  let candidate=null,score=0;
  for(let i=first;i<=latest;i++){
    const before=average(i-window*2,i-window);
    const after=average(i+window,i+window*2);
    if(before<.00005 || after>before*.42)continue;
    // Confirm the music does not return after the drop, allowing a quiet
    // recording tail rather than insisting on digital zero.
    const tail=average(i+window,n);
    if(tail>before*.47)continue;
    const ratio=before/(after+.00001);
    if(ratio>score){score=ratio;candidate=i*hopSeconds;}
  }
  return candidate===null?null:+candidate.toFixed(3);
}
