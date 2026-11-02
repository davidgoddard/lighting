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
  const threshold=clamp(Number(musicConfig.tangoColourChangeSensitivity??.45),.2,.95);
  const accentDelay=clamp(Number(musicConfig.tangoAccentFallbackDelaySeconds??1),0,20);
  const families=["rhythm","dynamics","harmony","timbre"],samples=families.map(name=>profile.traces[name]||[]),peakRadius=Math.max(1,Math.round(.35/step));
  const colourCues=[],accentCues=[],featureActivity=[];let lastNudge=-99,lastActivity=-99;
  for(let i=0;i<count;i+=1){
    const time=i*step;
    const salience=profile.traces.salience[i]||0,accent=profile.traces.accent[i]||0,combo=salience>=threshold&&accent>=.7,values=samples.map(trace=>trace[i]||0);
    if(Math.max(...values)>=Math.min(threshold,.45))lastActivity=time;featureActivity.push(lastActivity);
    const fired=[];for(let family=0;family<families.length;family+=1){const value=values[family];if(value<threshold)continue;let peak=true;
      for(let near=Math.max(0,i-peakRadius);near<=Math.min(count-1,i+peakRadius);near+=1){if(near===i)continue;
        if(samples[family][near]>value+1e-8||(near<i&&Math.abs(samples[family][near]-value)<1e-8)){peak=false;break;}}
      if(peak)fired.push(families[family]);}
    if(time<terminalDropStart && (fired.length||combo)&&time-lastNudge>=2){colourCues.push({time,start:Math.max(0,time-.6),source:fired.length?fired.join(" / "):"significance + accent"});lastNudge=time;}
    const previous=i?(profile.traces.accent[i-1]||0):0,next=i+1<count?(profile.traces.accent[i+1]||0):0,lastAccent=accentCues.at(-1)?.time??-99;
    if(time<terminalDropStart && accent>=.62&&accent>=previous&&accent>next&&time-lastAccent>=.35)accentCues.push({time,strength:accent});
  }
  const buildLane=seed=>{
    const chooseTarget=(hue,ordinal)=>{const distance=65+random01(3*(seed+ordinal))*110,direction=random01(3*(seed+ordinal)+1)<.5?-1:1;return normHue(hue+direction*distance);};
    const chooseDuration=ordinal=>1+19*random01(3*(seed+ordinal)+2);
    let hue=normHue(24+random01(seed+17)*360),target=chooseTarget(hue,0),ordinal=1,remaining=chooseDuration(0),cueIndex=0,transition=null;
    const frames=[];
    for(let i=0;i<count;i+=1){const time=i*step,build=profile.traces.build[i]||0;let cue="Wandering";const nextCue=colourCues[cueIndex];
      if(!transition&&nextCue&&time>=nextCue.start-1e-6){const amount=55+random01(seed+cueIndex*7+901)*38,sign=random01(seed+cueIndex*7+902)<.5?-1:1;transition={...nextCue,from:hue,delta:sign*amount,to:normHue(hue+sign*amount)};}
      if(transition){const fraction=clamp((time-transition.start)/Math.max(.001,transition.time-transition.start)),ease=smooth(fraction);hue=normHue(transition.from+transition.delta*ease);cue=`Arriving at ${transition.source}`;
        if(time>=transition.time-1e-6){hue=transition.to;cue=transition.source;transition=null;cueIndex+=1;}}
      else if(i>0){const effectiveStep=step*(1+1.8*build),fraction=Math.min(1,effectiveStep/Math.max(step,remaining));hue=normHue(hue+angularDelta(hue,target)*fraction);remaining-=effectiveStep;
        if(remaining<=1e-7||Math.abs(angularDelta(hue,target))<.01){hue=target;target=chooseTarget(hue,ordinal);remaining=chooseDuration(ordinal);ordinal+=1;cue="New wandering target";}}
      frames.push({hue,target,build,cue,remaining});
    }return frames;
  };
  const masterFrames=buildLane(7919),fixtureFrames=Object.fromEntries(fixtureIds.map(id=>[id,buildLane(hash(id))]));
  const selectedSalience=[];const eventThreshold=clamp(Number(musicConfig.tangoEventSensitivity??.49),.25,.9),eventSpacing=clamp(Number(musicConfig.tangoEventMinimumSpacingSeconds??3),1,15),peaks=[];
  for(let i=4;i<count-4;i+=1){const value=profile.traces.salience[i]||0;if(value>=eventThreshold&&value>=(profile.traces.salience[i-1]||0)&&value>(profile.traces.salience[i+1]||0))peaks.push({time:i*step,strength:value});}
  peaks.sort((a,b)=>b.strength-a.strength);for(const peak of peaks)if(selectedSalience.every(event=>Math.abs(event.time-peak.time)>=eventSpacing))selectedSalience.push(peak);
  const stateAt=(frames,time)=>{const exact=clamp(time/step,0,frames.length-1),i=Math.floor(exact),j=Math.min(frames.length-1,i+1),fraction=exact-i,frame=frames[i];return{...frame,hue:normHue(frame.hue+angularDelta(frame.hue,frames[j].hue)*fraction)};};
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
    const recentAccent=accentCues.filter(event=>Math.abs(time-event.time)<=.25);
    const lastColour=colourCues.filter(event=>event.time<=time).at(-1)?.time??-99;
    const activityIndex=Math.max(0,Math.min(featureActivity.length-1,Math.floor(time/step)));
    const lastActive=featureActivity[activityIndex]??-99;
    const idle=time-lastColour>=accentDelay && time-lastActive>=accentDelay;
    const dramatic=featureEnergy>=.58 || featureBuild>=.48 || sampleTrace(profile,"activity",time)>=.6;
    for(const event of recentAccent){
      if(!dramatic&&!idle)continue;
      const candidate=pulseEnvelope(time-event.time)*event.strength;
      if(candidate>pulseStrength){pulseStrength=candidate;pulseType=dramatic?"Rhythmic accent":"Accent";}
    }
    // A falling activity envelope is NOT a lighting cue. In particular the
    // final drop does not create a brightness flash or a hue nudge.
    const pulseAmount=terminalDrop?0:pulseStrength;
    brightness=clamp(baseline+(maximum-baseline)*pulseAmount,minimum,maximum);
    if(terminalDrop)cue="Terminal drop ignored; wandering";
    else if(pulseAmount>.015)cue=`${pulseType} pulse`;
    const feature=Object.fromEntries(["rhythm","dynamics","harmony","timbre","activityDrop","accent","build","salience","energy","activity"].map(name=>[name,sampleTrace(profile,name,time)]));
    return{time,scene:cue,reason:cue,feature,look:{hue:master.hue,targetHue:master.target,fixtureHues:Object.fromEntries(Object.entries(fixtureStates).map(([id,state])=>[id,state.hue])),fixtureTargets:Object.fromEntries(Object.entries(fixtureStates).map(([id,state])=>[id,state.target])),brightness,pulseStrength:pulseAmount,musicalState,saturation:.95,activity:feature.activity,accent:feature.accent,colourAcceleration:1+1.8*feature.build,minimumBrightness:minimum,maximumBrightness:maximum,cue,colourCueCount:colourCues.length,activityDropCount:0,selectedEventCount:selectedSalience.length},explanation:`${cue}; rhythm=${feature.rhythm.toFixed(2)}, dynamics=${feature.dynamics.toFixed(2)}, harmony=${feature.harmony.toFixed(2)}, timbre=${feature.timbre.toFixed(2)}`};
  };
}
