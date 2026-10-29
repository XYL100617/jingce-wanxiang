'use strict';

const path = require('node:path');
process.env.WORLD_MODEL_DATASET_DIR = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dataset_schedule_v0.2-fixed', 'environment'));
const { readSplit, poiFeatures, target, fit, predict, poiIds, horizons } = require('./train-graph-temporal-world-model');

function solve(matrix, vector) {
  const n=vector.length,a=matrix.map((row,i)=>[...row,vector[i]]);
  for(let col=0;col<n;col++){let pivot=col;for(let row=col+1;row<n;row++)if(Math.abs(a[row][col])>Math.abs(a[pivot][col]))pivot=row;
    if(Math.abs(a[pivot][col])<1e-10)continue;[a[col],a[pivot]]=[a[pivot],a[col]];const divisor=a[col][col];
    for(let k=col;k<=n;k++)a[col][k]/=divisor;for(let row=0;row<n;row++)if(row!==col){const f=a[row][col];for(let k=col;k<=n;k++)a[row][k]-=f*a[col][k];}}
  return a.map(row=>row[n]);
}
function logisticFit(rows,id,horizon,lambda){
  const records=[];for(const row of rows){const y=target(row,'poi',id,horizon),raw=poiFeatures(row,id,horizon);if(Number.isFinite(y)&&raw.every(Number.isFinite))records.push({raw,y:y>0?1:0});}
  const p=records[0]?.raw.length||0,means=Array(p).fill(0),scales=Array(p).fill(0);
  for(const r of records)for(let j=0;j<p;j++)means[j]+=r.raw[j]/records.length;
  for(const r of records)for(let j=0;j<p;j++)scales[j]+=(r.raw[j]-means[j])**2/records.length;
  for(let j=0;j<p;j++)scales[j]=Math.sqrt(scales[j])||1;
  const X=records.map(r=>[1,...r.raw.map((v,j)=>(v-means[j])/scales[j])]), Y=records.map(r=>r.y);
  const prevalence=Y.reduce((a,b)=>a+b,0)/Math.max(1,Y.length), beta=Array(p+1).fill(0);beta[0]=Math.log(Math.max(1e-5,prevalence)/Math.max(1e-5,1-prevalence));
  for(let iteration=0;iteration<30;iteration++){
    const h=Array.from({length:p+1},()=>Array(p+1).fill(0)),g=Array(p+1).fill(0);
    for(let i=0;i<X.length;i++){const z=X[i].reduce((s,v,j)=>s+v*beta[j],0),prob=1/(1+Math.exp(-Math.max(-30,Math.min(30,z)))),w=Math.max(1e-5,prob*(1-prob)),res=Y[i]-prob;
      for(let j=0;j<=p;j++){g[j]+=X[i][j]*res;for(let k=0;k<=p;k++)h[j][k]+=X[i][j]*X[i][k]*w;}}
    for(let j=1;j<=p;j++){h[j][j]+=lambda;g[j]-=lambda*beta[j];}
    const step=solve(h,g);for(let j=0;j<=p;j++)beta[j]+=step[j];if(Math.max(...step.map(Math.abs))<1e-6)break;
  }
  return {means,scales,beta};
}
function probability(model,raw){const z=[1,...raw.map((v,j)=>(v-model.means[j])/model.scales[j])].reduce((s,v,j)=>s+v*model.beta[j],0);return 1/(1+Math.exp(-Math.max(-30,Math.min(30,z))));}
function classificationScore(rows,models,horizon){const values=[];let brier=0,positive=0;
  for(const row of rows)for(const id of poiIds){const y=target(row,'poi',id,horizon),raw=poiFeatures(row,id,horizon);if(!Number.isFinite(y))continue;const label=y>0?1:0,p=probability(models[id],raw);values.push({p,label});brier+=(p-label)**2;positive+=label;}
  values.sort((a,b)=>b.p-a.p);let hits=0,ap=0;for(let i=0;i<values.length;i++)if(values[i].label){hits++;ap+=hits/(i+1);}const top=values.slice(0,Math.ceil(values.length*.1));
  return {n:values.length,positive_rate:positive/values.length,average_precision:ap/Math.max(1,positive),brier:brier/values.length,top10_precision:top.filter(x=>x.label).length/top.length};
}

function score(rows, models, transform, blend = 1) {
  let n=0, error=0, baselineError=0, persistError=0, zeroError=0, transformedBaselineError=0, predictedPositive=0, targetPositive=0, positiveError=0;
  const ranks=[];
  for (const row of rows) for (const id of poiIds) {
    const y=target(row,'poi',id,'target_5');
    if (!Number.isFinite(y)) continue;
    const raw=poiFeatures(row,id), value=raw[0], model=models[id];
    const learned=predict(model,raw);
    const simple=predict(model.__simple,[value]);
    if(!Number.isFinite(learned)||!Number.isFinite(simple)) return { n, mae:Infinity, simple_current_only_mae:null, persistence_mae:null };
    const estimate=Math.max(0, transform(blend*learned+(1-blend)*simple));
    ranks.push({ score:learned, label:y>0?1:0, simple_score:simple });
    n++; error+=Math.abs(estimate-y); baselineError+=Math.abs(simple-y); persistError+=Math.abs(value-y); zeroError+=Math.abs(y);
    transformedBaselineError+=Math.abs(Math.max(0,transform(simple))-y);
    if(estimate>0)predictedPositive++; if(y>0){targetPositive++;positiveError+=Math.abs(estimate-y);}
  }
  const averagePrecision=key=>{const sorted=[...ranks].sort((a,b)=>b[key]-a[key]);let hits=0,sum=0;for(let i=0;i<sorted.length;i++)if(sorted[i].label){hits++;sum+=hits/(i+1);}return hits?sum/hits:0;};
  const topCount=Math.ceil(n*.1), top=ranks.slice().sort((a,b)=>b.score-a.score).slice(0,topCount), topHits=top.filter(x=>x.label).length;
  return { n, mae:Number((error/n).toFixed(6)), current_only_average_precision:Number(averagePrecision('simple_score').toFixed(6)),
    model_average_precision:Number(averagePrecision('score').toFixed(6)), top10_precision:Number((topHits/topCount).toFixed(6)),
    simple_current_only_mae:Number((baselineError/n).toFixed(6)),
    transformed_simple_mae:Number((transformedBaselineError/n).toFixed(6)), always_zero_mae:Number((zeroError/n).toFixed(6)),
    persistence_mae:Number((persistError/n).toFixed(6)), predicted_positive_rate:Number((predictedPositive/n).toFixed(4)),
    target_positive_rate:Number((targetPositive/n).toFixed(4)), positive_target_mae:targetPositive?Number((positiveError/targetPositive).toFixed(6)):null };
}

async function main() {
  const [train,val,test]=await Promise.all(['train','val','test'].map(readSplit));
  const results=[];
  for (const lambda of [0,0.5,10,100,300,600,1000,2000,5000]) {
    const models={};
    for (const id of poiIds) {
      models[id]=fit(train,'poi',id,'target_5',poiFeatures,lambda);
      models[id].__simple=fit(train,'poi',id,'target_5',(row,key)=>[poiFeatures(row,key)[0]],lambda);
    }
    for (const [name,transform] of [['continuous',x=>x],['rounded',Math.round]]) for (const blend of [0,0.25,0.5,0.75,1])
      results.push({lambda,transform:name,blend,validation:score(val,models,transform,blend)});
    if (lambda===0.5) results.push({lambda,transform:'floor',blend:1,validation:score(val,models,Math.floor,1)});
  }
  const maeSorted=results.filter(result=>Number.isFinite(result.validation.mae)).sort((a,b)=>a.validation.mae-b.validation.mae);
  const rankSorted=results.filter(result=>Number.isFinite(result.validation.model_average_precision)).sort((a,b)=>b.validation.model_average_precision-a.validation.model_average_precision);
  const best=maeSorted[0], bestRank=rankSorted[0];
  const models={};
  for (const id of poiIds) {
    models[id]=fit(train,'poi',id,'target_5',poiFeatures,best.lambda);
    models[id].__simple=fit(train,'poi',id,'target_5',(row,key)=>[poiFeatures(row,key)[0]],best.lambda);
  }
  const transform=best.transform==='rounded'?Math.round:best.transform==='floor'?Math.floor:x=>x;
  const rankModels={};
  for (const id of poiIds) { rankModels[id]=fit(train,'poi',id,'target_5',poiFeatures,bestRank.lambda); rankModels[id].__simple=fit(train,'poi',id,'target_5',(row,key)=>[poiFeatures(row,key)[0]],bestRank.lambda); }
  const classifierResults=[];
  for(const horizon of horizons){const classifiers=[];
    for(const lambda of [.1,1,10,100]){const fitted={};for(const id of poiIds)fitted[id]=logisticFit(train,id,horizon,lambda);classifiers.push({horizon,lambda,models:fitted,validation:classificationScore(val,fitted,horizon)});}
    classifiers.sort((a,b)=>b.validation.average_precision-a.validation.average_precision);const bestClassifier=classifiers[0];
    classifierResults.push({horizon,validation_top:classifiers.slice(0,3).map(({lambda,validation})=>({lambda,validation})),
      test_once:classificationScore(test,bestClassifier.models,horizon),selected_lambda:bestClassifier.lambda});
  }
  const stripClassifier=({lambda,validation})=>({lambda,validation});
  process.stdout.write(JSON.stringify({best_mae_configuration:best,best_ranking_configuration:bestRank,
    validation_top_by_ranking:rankSorted.slice(0,5).map(({lambda,transform,blend,validation})=>({lambda,transform,blend,validation})),
    classification_by_horizon:classifierResults,
    test_once_after_validation_selection:{mae_selected:score(test,models,transform,best.blend),ranking_selected:score(test,rankModels,x=>x,1)},
    warning:'Test result was computed once for each validation-selected criterion; no tuning used test labels.'},null,2)+'\n');
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
