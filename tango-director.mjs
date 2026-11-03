// Pure-JavaScript lighting port of tango-salience-player 10/index.html.
const clamp=(value,min=0,max=1)=>Math.min(max,Math.max(min,value));
const smooth=value=>{const x=clamp(value);return x*x*(3-2*x);};
const normHue=hue=>((hue%360)+360)%360;
const angularDelta=(from,to)=>((to-from+540)%360)-180;
function random01(n){let x=(n+1)*2654435761>>>0;x^=x>>>16;x=Math.imul(x,2246822507)>>>0;x^=x>>>13;x=Math.imul(x,3266489909)>>>0;return((x^(x>>>16))>>>0)/4294967296;}
function hash(text){let value=2166136261;for(const character of text){value^=character.codePointAt(0);value=Math.imul(value,16777619);}return value>>>0;}
function sampleTrace(profile,name,time){const trace=profile.traces?.[name];if(!trace?.length)return 0;const exact=clamp(time/profile.samplePeriod,0,trace.length-1),i=Math.floor(exact),j=Math.min(trace.length-1,i+1),f=exact-i;return trace[i]*(1-f)+trace[j]*f;}

export function createTangoDirector(profile,musicConfig={},fixtureIds=[]){
  if(!profile?.traces?.salience?.length)throw new Error("Tango salience director requires profile.traces");
  const step=profile.samplePeriod||.2,count=profile.traces.salience.length,duration=Number(profile.duration)||count*step;
  // Only a terminal energy collapse is ignored. Earlier musical intensity,
  // accents and other changes remain eligible right up to that collapse.
  // The detector uses sustained low energy AFTER a sharp fall, not a fixed
  // "last N seconds" music-cue cutoff.
  const energyTrace=profile.traces.energy||[];
  const declaredEnd=Number(profile.finalSilenceStartSeconds);
  let terminalDropStart=profile.finalSilenceStartSeconds!=null && Number.isFinite(declaredEnd)
    ? declaredEnd : duration;
  // Some files have no silent tail, but the final decay is still detectable
  // in the normalised energy trace. Restrict this to the tail of the track.
  if(terminalDropStart===duration && energyTrace.length>3){
    const tail=Math.max(0,energyTrace.length-1),lookback=Math.max(1,Math.round(1/step));
    const lastValues=energyTrace.slice(Math.max(0,tail-Math.round(.6/step)),tail+1);
    const finalLevel=lastValues.reduce((sum,v)=>sum+v,0)/Math.max(1,lastValues.length);
    if(finalLevel<.23){
      for(let i=Math.max(lookback,tail-Math.round(2.5/step));i<=tail;i++){
        const preceding=energyTrace[Math.max(0,i-lookback)]||0;
        if(preceding>=.42 && preceding-(energyTrace[i]||0)>=.30){
          terminalDropStart=i*step;
          break;
        }
      }
    }
  }
  // Raw-RMS terminal collapse is preferred to normalised energy. For historical
  // recordings the final hiss may be too loud to qualify as digital silence.
  if(Number.isFinite(profile.terminalCollapseStartSeconds) && profile.terminalCollapseStartSeconds > 0)
    terminalDropStart=Math.min(terminalDropStart,profile.terminalCollapseStartSeconds);
  // Never turn the final negative acoustic edge into a hue nudge. Centred
  // analysis can place a false novelty peak slightly *before* the drop.
  // Only suppress early cues whose local energy clearly falls across the edge.
  const terminalEdgeCue=time=>{
    // Short deterministic end guard: if an archival recording has no measurable
    // silence, the final file boundary must still never become a new cue.
    // Only *new impulses* are vetoed; sustained colour movement continues.
    if(time>=duration-.8)return true;
    if(time>=terminalDropStart)return true;
    if(time<terminalDropStart-.8 || terminalDropStart>=duration)return false;
    const before=sampleTrace(profile,"energy",Math.max(0,time-.5));
    const after=sampleTrace(profile,"energy",Math.min(duration,terminalDropStart+.45));
    return before-after>=.18;
  };
  const threshold=clamp(Number(musicConfig.tangoColourChangeSensitivity??.45),.2,.95);
  const minimumHueDisplacement=clamp(Number(musicConfig.tangoMinimumHueDisplacementDegrees??55),30,150);
  const boostMultiplier=clamp(Number(musicConfig.tangoSpeedBoostMultiplier??6),1,12);
  const boostDecayMs=clamp(Number(musicConfig.tangoSpeedBoostDecayMs??1200),100,5000);
  const boostMaximum=clamp(Number(musicConfig.tangoMaximumSpeedMultiplier??18),2,40);
  const accentDelay=clamp(Number(musicConfig.tangoAccentFallbackDelaySeconds??1),0,20);
  const families=["rhythm","dynamics","harmony","timbre"],samples=families.map(name=>profile.traces[name]||[]),peakRadius=Math.max(1,Math.round(.35/step));
  const colourCues=[],accentCues=[],speedCues=[],featureActivity=[];let lastActivity=-99;
  for(let i=0;i<count;i+=1){
    const time=i*step;
    const salience=profile.traces.salience[i]||0,accent=profile.traces.accent[i]||0,combo=salience>=threshold&&accent>=.7,values=samples.map(trace=>trace[i]||0);
    if(Math.max(...values)>=Math.min(threshold,.45))lastActivity=time;featureActivity.push(lastActivity);
    const fired=[];for(let family=0;family<families.length;family+=1){const value=values[family];if(value<threshold)continue;let peak=true;
      for(let near=Math.max(0,i-peakRadius);near<=Math.min(count-1,i+peakRadius);near+=1){if(near===i)continue;
        if(samples[family][near]>value+1e-8||(near<i&&Math.abs(samples[family][near]-value)<1e-8)){peak=false;break;}}
      if(peak)fired.push(families[family]);}
    if(!terminalEdgeCue(time) && (fired.length||combo))colourCues.push({time,start:Math.max(0,time-.6),source:fired.length?fired.join(" / "):"significance + accent",strength:Math.max(salience,...values)});
    const previous=i?(profile.traces.accent[i-1]||0):0,next=i+1<count?(profile.traces.accent[i+1]||0):0;
    if(!terminalEdgeCue(time) && accent>=.62&&accent>=previous&&accent>next)accentCues.push({time,strength:accent});
  }
  // Local peaks feed one shared, decaying acceleration envelope. No minimum
  // spacing: multiple independent impulses accumulate, bounded by a hard cap.
  // Nearby colour + accent peaks in the same analysis frame count once.
  const eventThreshold=clamp(Number(musicConfig.tangoEventSensitivity??.49),.25,.9);
  for(let i=1;i<count-1;i++){
    const time=i*step;
    if(terminalEdgeCue(time))continue;
    const level=profile.traces.salience[i]||0;
    const prev=profile.traces.salience[i-1]||0,next=profile.traces.salience[i+1]||0;
    if(level>=eventThreshold&&level>=prev&&level>next)speedCues.push({time,strength:level});
  }
  for(const event of accentCues){
    const near=speedCues.find(cue=>Math.abs(cue.time-event.time)<step*.55);
    if(near)near.strength=Math.max(near.strength,event.strength);
    else speedCues.push({...event});
  }
  // Hue-change events are also meaningful impulses even when salience is low.
  for(const event of colourCues){
    const near=speedCues.find(cue=>Math.abs(cue.time-event.time)<step*.55);
    if(near)near.strength=Math.max(near.strength,clamp(event.strength));
    else speedCues.push({time:event.time,strength:clamp(event.strength)});
  }
  speedCues.sort((a,b)=>a.time-b.time);
  const decaySeconds=boostDecayMs/1000;
  const boostTrace=Array(count).fill(1);
  let activeBoost=0,nextSpeedCue=0;
  for(let i=0;i<count;i++){
    const time=i*step;
    if(i>0)activeBoost*=Math.exp(-4*step/decaySeconds);
    while(nextSpeedCue<speedCues.length&&speedCues[nextSpeedCue].time<=time+1e-6){
      activeBoost+=(boostMultiplier-1)*speedCues[nextSpeedCue].strength;
      nextSpeedCue++;
    }
    // Clip AFTER accumulation so repeated events add rather than replace.
    boostTrace[i]=Math.min(boostMaximum,1+activeBoost);
  }
  const effectiveAccelerationAt=i=>Math.min(boostMaximum,(1+1.8*(profile.traces.build[i]||0))*boostTrace[i]);
  const buildLane=seed=>{
    const chooseTarget=(hue,ordinal)=>{const distance=65+random01(3*(seed+ordinal))*110,direction=random01(3*(seed+ordinal)+1)<.5?-1:1;return normHue(hue+direction*distance);};
    const chooseDuration=ordinal=>1+19*random01(3*(seed+ordinal)+2);
    let hue=normHue(24+random01(seed+17)*360),target=chooseTarget(hue,0),ordinal=1,remaining=chooseDuration(0),cueIndex=0,transition=null;
    const frames=[];
    for(let i=0;i<count;i+=1){const time=i*step,build=profile.traces.build[i]||0;let cue="Wandering";const nextCue=colourCues[cueIndex];
      if(!transition&&nextCue&&time>=nextCue.start-1e-6){const amount=minimumHueDisplacement+random01(seed+cueIndex*7+901)*Math.min(40,180-minimumHueDisplacement),sign=random01(seed+cueIndex*7+902)<.5?-1:1;transition={...nextCue,from:hue,delta:sign*amount,to:normHue(hue+sign*amount)};}
      if(transition){const fraction=clamp((time-transition.start)/Math.max(.001,transition.time-transition.start)),ease=smooth(fraction);hue=normHue(transition.from+transition.delta*ease);cue=`Arriving at ${transition.source}`;
        if(time>=transition.time-1e-6){hue=transition.to;cue=transition.source;transition=null;cueIndex+=1;}}
      else if(i>0){const effectiveStep=step*effectiveAccelerationAt(i),fraction=Math.min(1,effectiveStep/Math.max(step,remaining));hue=normHue(hue+angularDelta(hue,target)*fraction);remaining-=effectiveStep;
        if(remaining<=1e-7||Math.abs(angularDelta(hue,target))<.01){hue=target;target=chooseTarget(hue,ordinal);remaining=chooseDuration(ordinal);ordinal+=1;cue="New wandering target";}}
      frames.push({hue,target,build,cue,remaining,acceleration:effectiveAccelerationAt(i),speedBoost:boostTrace[i]});
    }return frames;
  };
  const masterFrames=buildLane(7919),fixtureFrames=Object.fromEntries(fixtureIds.map(id=>[id,buildLane(hash(id))]));
  const selectedSalience=[];const peaks=[];
  for(let i=4;i<count-4;i+=1){const value=profile.traces.salience[i]||0;if(value>=eventThreshold&&value>=(profile.traces.salience[i-1]||0)&&value>(profile.traces.salience[i+1]||0))peaks.push({time:i*step,strength:value});}
  // All locally significant events remain eligible; no minimum separation.
  selectedSalience.push(...peaks.sort((a,b)=>a.time-b.time));
  const stateAt=(frames,time)=>{const exact=clamp(time/step,0,frames.length-1),i=Math.floor(exact),j=Math.min(frames.length-1,i+1),fraction=exact-i,frame=frames[i],next=frames[j];return{...frame,hue:normHue(frame.hue+angularDelta(frame.hue,next.hue)*fraction),acceleration:frame.acceleration+(next.acceleration-frame.acceleration)*fraction,speedBoost:frame.speedBoost+(next.speedBoost-frame.speedBoost)*fraction};};
  return function at(position,currentMusicConfig=musicConfig){
    const time=clamp(Number(position)||0,0,duration),master=stateAt(masterFrames,time),fixtureStates=Object.fromEntries(Object.entries(fixtureFrames).map(([id,frames])=>[id,stateAt(frames,time)]));
    const minimum=clamp(Number(currentMusicConfig.minimumBrightnessPercent??62)/100),maximum=clamp(Number(currentMusicConfig.maximumBrightnessPercent??100)/100,minimum,1);
    const terminalDrop=time>=terminalDropStart;
    const featureEnergy=sampleTrace(profile,"energy",time);
    const featureBuild=sampleTrace(profile,"build",time);
    const musicalState = featureEnergy < .25 && featureBuild < .25 ? "GENTLE"
      : featureBuild >= .55 ? "BUILDING"
      : featureEnergy >= .72 ? "DRAMATIC"
      : featureBuild <= .12 && featureEnergy >= .4 ? "SUSTAINED" : "MODERATE";
    // Never let long-term energy consume the headroom needed for rhythmic accents.
    const baseline=minimum+(maximum-minimum)*.32*clamp(featureEnergy);
    let brightness=baseline,cue=master.cue,pulseStrength=0,pulseType="none";
    // A Gaussian centred on the attack with a 0.5-second window. Because the
    // entire recording is analysed before playback, the ramp can begin early.
    // At the +/-0.25 second edges the pulse has fallen to ~1% amplitude.
    const pulseEnvelope=(distance)=>Math.abs(distance)>.25 ? 0 : Math.exp(-.5*(distance/.082)**2);
    // Positive values move only brightness pulses later than the audio event;
    // the existing AV delay remains the timing control for all other effects.
    const pulseDelaySeconds=clamp(Number(currentMusicConfig.tangoPulseDelayMs??200),-500,500)/1000;
    const recentAccent=accentCues.filter(event=>Math.abs(time-event.time-pulseDelaySeconds)<=.25);
    const lastColour=colourCues.filter(event=>event.time<=time).at(-1)?.time??-99;
    const activityIndex=Math.max(0,Math.min(featureActivity.length-1,Math.floor(time/step)));
    const lastActive=featureActivity[activityIndex]??-99;
    const idle=time-lastColour>=accentDelay && time-lastActive>=accentDelay;
    const dramatic=featureEnergy>=.58 || featureBuild>=.48 || sampleTrace(profile,"activity",time)>=.6;
    for(const event of recentAccent){
      if(!dramatic&&!idle)continue;
      const candidate=pulseEnvelope(time-event.time-pulseDelaySeconds)*event.strength;
      if(candidate>pulseStrength){pulseStrength=candidate;pulseType=dramatic?"Rhythmic accent":"Accent";}
    }
    // A falling activity envelope is NOT a lighting cue. In particular the
    // final drop does not create a brightness flash or a hue nudge.
    const pulseAmount=terminalDrop?0:pulseStrength;
    brightness=clamp(baseline+(maximum-baseline)*pulseAmount,minimum,maximum);
    if(terminalDrop)cue="Terminal drop ignored; wandering";
    else if(pulseAmount>.015)cue=`${pulseType} pulse`;
    const feature=Object.fromEntries(["rhythm","dynamics","harmony","timbre","activityDrop","accent","build","salience","energy","activity"].map(name=>[name,sampleTrace(profile,name,time)]));
    return{time,scene:cue,reason:cue,feature,look:{hue:master.hue,targetHue:master.target,fixtureHues:Object.fromEntries(Object.entries(fixtureStates).map(([id,state])=>[id,state.hue])),fixtureTargets:Object.fromEntries(Object.entries(fixtureStates).map(([id,state])=>[id,state.target])),brightness,pulseStrength:pulseAmount,musicalState,saturation:.95,activity:feature.activity,accent:feature.accent,colourAcceleration:master.acceleration,speedBoost:master.speedBoost,speedEventCount:speedCues.length,terminalDropStartSeconds:terminalDropStart,pulseDelayMs:pulseDelaySeconds*1000,minimumBrightness:minimum,maximumBrightness:maximum,cue,colourCueCount:colourCues.length,activityDropCount:0,selectedEventCount:selectedSalience.length},explanation:`${cue}; rhythm=${feature.rhythm.toFixed(2)}, dynamics=${feature.dynamics.toFixed(2)}, harmony=${feature.harmony.toFixed(2)}, timbre=${feature.timbre.toFixed(2)}`};
  };
}
