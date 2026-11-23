// v5.23 : tests amis / messages privés / groupes  (lancer le serveur : PORT=3999 DATA_DIR=/tmp/d node server.js ; puis node test_social.js)
const B=process.env.BASE||'http://localhost:3999';
async function j(m,p,b,t){const r=await fetch(B+p,{method:m,headers:Object.assign({'Content-Type':'application/json'},t?{Authorization:'Bearer '+t}:{}),body:b?JSON.stringify(b):undefined});let o={};try{o=await r.json()}catch(e){}return [r.status,o]}
const ok=(n,c,d)=>console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+JSON.stringify(d)));
(async()=>{
 const reg=async n=>{const [s,r]=await j('POST','/v1/register',{username:n,password:'motdepasse',question:'Question test ?',answer:'reponse'});return r.token};
 const A=await reg('Ana'),Bo=await reg('Bob'),C=await reg('Cleo');let s,r;
 [s,r]=await j('POST','/v1/friends/request',{name:'inconnu'},A);ok('ami inconnu = 404',s===404,r);
 [s,r]=await j('POST','/v1/friends/request',{name:'ana'},A);ok('pas soi-même',s===400,r);
 [s,r]=await j('POST','/v1/friends/request',{name:'BOB'},A);ok('demande envoyée',s===200&&r.status==='pending'&&r.name==='Bob',r);
 [s,r]=await j('GET','/v1/friends',null,Bo);ok('Bob voit la demande',r.incoming.length===1&&r.incoming[0]==='Ana',r);
 [s,r]=await j('POST','/v1/dm',{to:'bob',text:'salut'},A);ok('DM refusé avant amitié',s===403,r);
 [s,r]=await j('POST','/v1/friends/accept',{name:'ana'},Bo);ok('acceptée',s===200&&r.status==='friends',r);
 [s,r]=await j('GET','/v1/friends',null,A);ok('Ana a Bob en ami',r.friends[0]==='Bob'&&!r.outgoing.length,r);
 [s,r]=await j('POST','/v1/dm',{to:'bob',text:'Salut Bob'},A);ok('DM envoyé',s===201&&r.user==='Ana',r);
 [s,r]=await j('POST','/v1/dm',{to:'ana',text:'Salut Ana'},Bo);ok('DM réponse',s===201,r);
 [s,r]=await j('GET','/v1/dm?with=ana',null,Bo);ok('Bob lit la conversation',r.messages.length===2&&r.messages[0].user==='Ana',r);
 [s,r]=await j('GET','/v1/dm?with=ana&after=1',null,Bo);ok('after',r.messages.length===1,r);
 [s,r]=await j('GET','/v1/dm?with=ana',null,C);ok('Cléo ne lit pas la conversation',s===403,r);
 [s,r]=await j('POST','/v1/friends/request',{name:'cleo'},Bo);[s,r]=await j('POST','/v1/friends/request',{name:'bob'},C);ok('demande croisée = amis',r.status==='friends',r);
 [s,r]=await j('POST','/v1/groups',{name:'x',members:[]},A);ok('nom court refusé',s===400,r);
 [s,r]=await j('POST','/v1/groups',{name:'Team',members:['cleo']},A);ok('non-ami refusé',s===403,r);
 [s,r]=await j('POST','/v1/groups',{name:'Team',members:['bob']},A);ok('groupe créé',s===201&&r.members.length===2,r);const gid=r.id;
 [s,r]=await j('POST','/v1/group',{id:gid,text:'Salut la team'},Bo);ok('message de groupe',s===201,r);
 [s,r]=await j('GET','/v1/group?id='+gid,null,A);ok('Ana lit le groupe',r.messages.length===1&&r.messages[0].user==='Bob',r);
 [s,r]=await j('GET','/v1/group?id='+gid,null,C);ok('Cléo hors groupe = 404',s===404,r);
 [s,r]=await j('POST','/v1/groups/add',{id:gid,name:'cleo'},Bo);ok('Bob ajoute Cléo (son amie)',s===200&&r.members.length===3,r);
 [s,r]=await j('GET','/v1/groups',null,C);ok('Cléo voit le groupe',r.groups.length===1,r);
 [s,r]=await j('POST','/v1/groups/leave',{id:gid},C);[s,r]=await j('GET','/v1/groups',null,C);ok('Cléo quitte',r.groups.length===0,r);
 [s,r]=await j('POST','/v1/friends/remove',{name:'bob'},A);[s,r]=await j('GET','/v1/friends',null,Bo);ok('amitié retirée des deux côtés',!r.friends.includes('Ana'),r);
 [s,r]=await j('POST','/v1/dm',{to:'bob',text:'x'},A);ok('DM refusé après retrait',s===403,r);
})();
