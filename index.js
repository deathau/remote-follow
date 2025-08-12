const forge = require('node-forge')
const express = require('express')
const hbs = require('express-handlebars')
const cookieSession = require('cookie-session')
const app = express()
const port = process.env.port || 3000

let baseUrl = `http://localhost:${port}`

app.engine('.hbs', hbs.engine({extname: '.hbs',
  helpers: {
    json(obj, level=0) { return JSON.stringify(obj,null,level) },
    domain(urlstring) { 
      try { return new URL(urlstring).hostname }
      catch(e){
        console.error(e)
        return null
      }
    },
    origin(urlstring) { 
      try { return new URL(urlstring).origin }
      catch(e){
        console.error(e)
        return null
      }
    }
  }
}))
app.set('view engine', '.hbs')
app.set('views', './views')

// For parsing application/json
app.use(express.json());

// For parsing application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));

app.set('trust proxy', 1) // trust first proxy
// cookies for storing follower data
app.use(cookieSession({
  keys: ['key1', 'key2'],
  // Cookie Options
  maxAge: 7 * 24 * 60 * 60 * 1000 // a week
}))

const SUBSCRIBE_LINK_REL = 'http://ostatus.org/schema/1.0/subscribe'
const AVATAR_LINK_REL = 'http://webfinger.net/rel/avatar'
const SELF_LINK_REL = 'self'
const SELF_LINK_TYPE = 'application/activity+json'
const AP_HEADERS = [
  'application/ld+json; profile="http://www.w3.org/ns/activitystreams"',
  'application/activity+json'
]

function findURL(links, rel, type = null, prop = 'href') {
  const link = links.find(link => link.rel && link.rel == rel && (!type || link.type == type))
  const urlstring = link ? link[prop] : null
  try { return new URL(urlstring) }
  catch { return null }
}

async function getWebfinger(handle){
  const split = handle.split('@')
  if(split.length == 2) {
    const resource = `acct:${handle}`
    const domain = split[1]
    
    // look up remote user via webfinger
    const url = `https://${domain}/.well-known/webfinger?resource=${resource}`
    const webfingerresult = await fetch(url, {headers: {
      'Accept': 'application/json'
    }})
    return await webfingerresult.json()
  }
  else {
    throw('Handle needs exactly one `@` symbol')
  }
}

async function getAPData(url){

  const urlObj = 
    typeof url === 'string' ? new URL(url) 
    : url instanceof Request ? new URL(url.url)
    : url

  const key = forge.pki.privateKeyFromPem(process.env.PRIVATE_KEY)

  const dataObj = { }
  dataObj['(request-target)'] = `get ${urlObj.pathname + urlObj.search + urlObj.hash}`
  dataObj.host = urlObj.hostname
  dataObj.date = new Date().toUTCString()

  const data = Object.entries(dataObj).map(([key, value]) => `${key}: ${value}`).join('\n')
  const signature = forge.util.encode64(key.sign(forge.md.sha256.create().update(data)))
  const signatureObj = {
    keyId: `${baseUrl}#main-key`,
    headers: Object.keys(dataObj).join(' '),
    signature: signature
  }
  const headers = {
    host: dataObj.host,
    date: dataObj.date,
    signature: Object.entries(signatureObj).map(([key,value]) => `${key}="${value}"`).join(','),
    accept: AP_HEADERS[0]
  }
  
  const dataresult = await fetch(url, { headers })
  return await dataresult.json()
}

function getIdOrHandle(idOrHandle) {
  let person = {
    id: null,
    handle: null
  }
  const handleMatch = idOrHandle.match(/^@?([^\/]*@[^\/]*\.[^\/]*)$/)
  if(handleMatch) person.handle = handleMatch[1]

  try { if(!person.handle) person.id = new URL(idOrHandle) }
  catch { person.id = null }

  return person
}

async function buildPerson(idOrHandle) {
  let data, webfinger
  let person = getIdOrHandle(idOrHandle)

  // check if we've got a valid handle or ID. We need one or the other.
  if(!person.handle && !person.id) {
    throw 'Please supply a valid id or handle.'
  }
  // if we've got a handle and not an id, we need to 'webfinger' the handle to get the id
  else if(person.handle && !person.id){
    webfinger = await getWebfinger(person.handle)
    person.id = findURL(webfinger.links, SELF_LINK_REL, SELF_LINK_TYPE)
    // also populate the data for this person
    data = await getAPData(person.id)
  }
  // if we've got an id but no handle, can build the handle from the preferredUsername and domain
  // though first, we have to fetch the person's data to get the preferredUsername
  else if(!person.handle && person.id) {
    data = await getAPData(person.id)
    person.handle = `${data.preferredUsername}@${person.id.hostname}`
    // also populate the webfinger data for this person
    webfinger = await getWebfinger(person.handle)
  }

  if(data.error) person.error = data.error

  // get the person's avatar url. First try the webfinger, then pull from profile data
  person.avatar = findURL(webfinger.links, AVATAR_LINK_REL)
  if(!person.avatar && data.icon){
    let icon = data.icon
    // this could be an array of urls
    if(Array.isArray(icon)) icon = icon[0]

    // the url might be a string, but it might be an object (usually with a url property?)
    if(typeof icon === "string") person.avatar = icon
    else if(Object.hasOwn(icon, 'url')) person.avatar = icon.url
  }

  // also get the person's subscribe link (from the webfinger links)
  person.subscribe = findURL(webfinger.links, SUBSCRIBE_LINK_REL, null, 'template')
  
  // finally, we want the person's name and summary (from their profile data)
  person.name = data.name
  person.summary = data.summary
  person.url = data.url

  // console.log({webfinger, data})

  // this is all the data I'm using for now
  return person
}

app.all(/^\/(.*)/, async (req, res) => {
  try{
    baseUrl = req.protocol + '://' + req.get('host')
    console.log(new Date(), baseUrl + req.originalUrl, req.header('Accept'))

    if(req.originalUrl.startsWith('/.well-known/webfinger') && req.query?.resource){
      req.query.resource
      let webfinger = {
        subject: req.query.resource,
        aliases: [baseUrl],
        links:[
          {
            "rel":"self",
            "href":baseUrl,
            "type":"application/activity+json"
          },
          {
            "rel":"http://webfinger.net/rel/profile-page",
            "href":baseUrl
          },
          {
            "rel":SUBSCRIBE_LINK_REL,
            "href":`${baseUrl}/{uri}`
          }
        ]
      }
      return res.header('Content-Type','application/json').send(webfinger)
    }
    else if(req.header('Accept') && AP_HEADERS.some(h => req.header('Accept').includes(h))){
      let actor = {
        "@context": [
          "https://www.w3.org/ns/activitystreams",
          "https://w3id.org/security/v1",
          {
              "manuallyApprovesFollowers": "as:manuallyApprovesFollowers",
              "toot": "http://joinmastodon.org/ns#",
              "featured": {
                  "@id": "toot:featured",
                  "@type": "@id"
              },
              "featuredTags": {
                  "@id": "toot:featuredTags",
                  "@type": "@id"
              },
              "alsoKnownAs": {
                  "@id": "as:alsoKnownAs",
                  "@type": "@id"
              },
              "movedTo": {
                  "@id": "as:movedTo",
                  "@type": "@id"
              },
              "schema": "http://schema.org#",
              "PropertyValue": "schema:PropertyValue",
              "value": "schema:value",
              "discoverable": "toot:discoverable",
              "suspended": "toot:suspended",
              "memorial": "toot:memorial",
              "indexable": "toot:indexable",
              "attributionDomains": {
                  "@id": "toot:attributionDomains",
                  "@type": "@id"
              },
              "focalPoint": {
                  "@container": "@list",
                  "@id": "toot:focalPoint"
              }
          }
        ],
        id: baseUrl,
        type: 'Application',
        "discoverable": true,
        "indexable": false,
        publicKey:{
          id: `${baseUrl}#main-key`,
          owner: baseUrl,
          publicKeyPem: process.env.PUBLIC_KEY
        },
        name: 'Remote Follow',
        preferredUsername: 'RemoteFollow',
        url: baseUrl
      }
      return res.header('Content-Type','application/activity+json').send(actor)
    }
    else {
      const person = req.body?.person ? JSON.parse(req.body.person) : await buildPerson(req.params[0])
      let follower = req.session?.follower || null
      if(req.body?.logout != null){
        follower = null
        req.session = null
      }
      else if(req.body?.idOrHandle){
        try{
          follower = await buildPerson(req.body.idOrHandle)
        }
        catch(e) {
          follower = getIdOrHandle(req.body.idOrHandle)
          follower.idOrHandle = req.body.idOrHandle
          follower.error = e;
        }
        
        if(!follower.error) req.session.follower = follower
      }
      
      if(follower?.subscribe) follower.subscribe = follower.subscribe.toString().replace('{uri}', person.id.toString())
      res.render('form', {person, follower})
    }
  }
  catch(e) {
    console.error(e)
    let person = {
      idOrHandle: req.params[0],
      error: e
    }
    let follower = req.session?.follower || null
    res.status(400).render('form', {person, follower})
  }
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})
