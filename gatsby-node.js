/**
 *  Copyright 2020 Adobe. All rights reserved.
 *  This file is licensed to you under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License. You may obtain a copy
 *  of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software distributed under
 *  the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 *  OF ANY KIND, either express or implied. See the License for the specific language
 *  governing permissions and limitations under the License.
 */

/**
 * Implement Gatsby's Node APIs in this file.
 *
 * See: https://www.gatsbyjs.org/docs/node-apis/
 */

// You can delete this file if you're not using it
require("dotenv").config({
  path: `.env.${process.env.NODE_ENV}`,
})
const path = require(`path`)
const fs = require(`fs`)
const openApiSnippet = require(`openapi-snippet`)
const GitUrlParse = require(`git-url-parse`)
const elasticlunr = require(`elasticlunr`)
const { GraphQLJSONObject } = require("graphql-type-json")
const converter = require("widdershins")
const SwaggerParser = require("@apidevtools/swagger-parser")
const glob = require("fast-glob")
const YAML = require("yaml")
// const { withPrefix } = require("gatsby")

const SITE_TAB_TYPE = `SiteTabs`

const openApiSearchDocs = []

const pages = []

const renameProp = (oldProp, newProp, { [oldProp]: old, ...others }) => ({
  [newProp]: old,
  ...others,
})

async function asyncForEach(array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array)
  }
}

const cleanString = (str = "") =>
  str.replace(/"/g, "").replace(/“/g, "").replace(/”/g, "")

const searchTree = (theObject, matchingFilename) => {
  var result = null
  if (theObject instanceof Array) {
    for (var i = 0; i < theObject.length; i++) {
      result = searchTree(theObject[i], matchingFilename)
      if (result) {
        break
      }
    }
  } else {
    for (var prop in theObject) {
      if (prop === "path") {
        if (theObject[prop] && theObject[prop].endsWith(matchingFilename)) {
          return theObject.title
        }
      }
      if (
        theObject[prop] instanceof Object ||
        theObject[prop] instanceof Array
      ) {
        result = searchTree(theObject[prop], matchingFilename)
        if (result) {
          break
        }
      }
    }
  }
  return result
}

const gitRepoInfo = () => {
  const gitInfo = GitUrlParse(process.env.GATSBY_SOURCE)
  return {
    protocol: gitInfo.protocol,
    resource: gitInfo.resource,
    full_name: `${gitInfo.owner}/${gitInfo.name}`,
    organization: gitInfo.owner,
    name: gitInfo.name,
    ref: process.env.GATSBY_SOURCE_BRANCH,
  }
}

const loadTemplates = () => {
  const templateFiles = glob.sync(`src/templates/**`)

  return templateFiles.reduce(function (result, item) {
    const templateName = path.parse(item).name
    result[templateName] = path.resolve(item)
    return result
  }, {})
}

exports.onCreateNode = ({ node, actions }) => {
  const { createNodeField } = actions
  if (node.internal.type === `MarkdownRemark`) {
    let slug = ""
    if (node.frontmatter.path) {
      slug = node.frontmatter.path
    } else {
      const localFilePath = path.relative(
        `${process.env.LOCAL_PROJECT_DIRECTORY}`,
        node.fileAbsolutePath
      )
      slug = path.join("/", ...localFilePath.split(path.sep))
    }

    if (
      node.frontmatter &&
      Object.prototype.hasOwnProperty.call(node.frontmatter, "author")
    ) {
      const author = node.frontmatter.author || "unknown"
      createNodeField({
        node,
        name: "authorId",
        value: cleanString(author),
      })
    }

    createNodeField({
      node,
      name: `slug`,
      value: slug,
    })

    createNodeField({
      node,
      name: `id`,
      value: node.parent,
    })
  }
}

exports.createPages = async ({ actions, graphql }) => {
  const { createPage } = actions

  const templates = loadTemplates()
  // Default template
  const docTemplate = path.resolve(`src/templates/markdown.js`)

  const gitRemote = gitRepoInfo()

  const result = await graphql(
    `
      query {
        allMarkdownRemark(sort: { fields: [frontmatter___date], order: DESC }) {
          edges {
            node {
              fileAbsolutePath
              fields {
                id
                slug
                authorId
              }
              frontmatter {
                title
                tags
                author
                template
              }
            }
          }
        }
        allGithubContributors {
          edges {
            node {
              id
              contributors {
                date
                login
                name
                avatarUrl
              }
              path
            }
          }
        }
        parliamentNavigation {
          pages
          homePage
        }
        allParliamentJsonSchema {
          edges {
            node {
              id
              _id
              _schema
              description
              properties
              slug
              title
              type
              _defs
              required
            }
          }
        }
      }
    `
  )

  if (result.errors) {
    // console.log(result.errors)
    result.errors.map((error) => {
      if (error.message.indexOf("parliamentNavigation")) {
        process.exit(1)
      }
    })
  }

  const posts = [],
    docs = []
  result.data.allMarkdownRemark.edges.map((post) => {
    post.node.fields.slug.includes("blog/") ? posts.push(post) : docs.push(post)
  })
  const contributors = result.data.allGithubContributors.edges
  const parliamentNavigation = result.data.parliamentNavigation

  // Create JSON Schema pages
  result.data.allParliamentJsonSchema.edges.map(({ node }) => {
    if (node.slug !== "/dummy-schema") {
      createPage({
        path: node.slug,
        component: templates["json-schema"],
        context: {
          id: node.id,
          slug: node.slug,
          gitRemote: gitRemote,
          schema: node,
        },
      })
    }
  })

  if (posts.length > 0) {
    const postsNav = {
      importedFileName: "posts",
      pages: [],
      path: `/blog`,
      title: "Posts",
    }

    // Create a map of all the authors
    const authorMap = new Map()

    // Create blog posts pages.
    posts.forEach((post, index) => {
      const previous = index === posts.length - 1 ? null : posts[index + 1].node
      const next = index === 0 ? null : posts[index - 1].node
      const postAuthor = cleanString(post.node.frontmatter.author)

      const contributorsObj = contributors.find(
        (obj) => obj.node.path === post.node.fileAbsolutePath
      )
      const author = contributorsObj?.node?.contributors.find(
        (contributor) => contributor.login === postAuthor
      ) ?? {
        login: postAuthor,
        name: postAuthor,
      }

      authorMap.set(postAuthor, author)

      createPage({
        path: post.node.fields.slug,
        component: templates["blog-post"],
        context: {
          slug: post.node.fields.slug,
          previous,
          next,
          pages: pages,
          author: author,
          gitRemote: gitRemote,
        },
      })
    })

    // Create the map of all the tags
    const tagMap = new Map()

    posts.forEach((post) => {
      postsNav.pages.push({
        importedFileName: "posts",
        pages: [],
        path: `/${post.node.fields.slug}`.replace(/\/\//g, "/"),
        title: post.node.frontmatter.title,
      })

      const tags = post.node?.frontmatter?.tags?.split(",")
      return (
        tags &&
        tags.map((tag) => {
          const trimmedTag = tag.trim()
          if (tagMap.has(trimmedTag)) {
            tagMap.set(trimmedTag, tagMap.get(trimmedTag) + 1)
          } else {
            tagMap.set(trimmedTag, 1)
          }
        })
      )
    })

    const authors = {
      importedFileName: "authors",
      pages: [],
      path: `/blog/authors/`,
      title: "Authors",
    }

    // Add each other to the side nav
    authorMap.forEach((author) => {
      authors.pages.push({
        importedFileName: `${author.login}`,
        pages: [],
        path: `/blog/author/${author.login}/`,
        title: `${author.name || author.login}`,
      })
    })

    const tags = {
      importedFileName: "tags",
      pages: [],
      path: `/blog/tags/`,
      title: "Tags",
    }

    // Descending sort of our map to get most popular tags
    const sortedTagMap = new Map(
      [...tagMap.entries()].sort((a, b) => b[1] - a[1])
    )

    // Add each tag to the side nav
    for (let [key, value] of sortedTagMap) {
      tags.pages.push({
        importedFileName: `${key}`,
        pages: [],
        path: `/blog/tags/${key}/`,
        title: `${value} #${key}`,
      })

      createPage({
        path: `/blog/tags/${key}/`,
        component: templates["tag"],
        context: {
          tagName: `/${key}/`,
          gitRemote: gitRemote,
        },
      })
    }

    pages.push(postsNav)
    pages.push(authors)
    pages.push(tags)

    const authorList = []
    authorMap.forEach((author) => authorList.push(author))

    createPage({
      path: `/blog/authors/`,
      component: templates["authors"],
      context: {
        slug: `/blog/authors/`,
        pages: pages,
        authors: authorList,
        gitRemote: gitRemote,
      },
    })
    authorMap.forEach((author) => {
      createPage({
        path: `/blog/author/${author.login}/`,
        component: templates["author"],
        context: {
          authorId: author.login,
          author: author,
          gitRemote: gitRemote,
        },
      })
    })

    createPage({
      path: `/blog`,
      component: templates["blog-index"],
      context: {
        pages: pages,
        contributors: contributors,
        gitRemote: gitRemote,
      },
    })
  }

  try {
    if (docs) {
      docs.forEach(({ node }) => {
        const contributorsObj = contributors.find(
          (obj) => obj.node.path === node.fileAbsolutePath
        )
        const fileContributors = contributorsObj?.node?.contributors ?? []
        const template =
          node?.frontmatter?.template && templates[node.frontmatter.template]
            ? templates[node.frontmatter.template]
            : docTemplate

        if (node.fields.slug !== "") {
          let seo = searchTree(parliamentNavigation.pages, node.fields.slug)
          createPage({
            path: node.fields.slug,
            component: template,
            context: {
              dirname: path.parse(node.fields.slug).dir,
              slug: node.fields.slug,
              id: node.fields.id,
              seo: seo,
              gitRemote: gitRemote,
              contributors: fileContributors,
            },
          })
        }
      })
    }
  } catch (e) {
    console.log("Skipping Markdown files")
    console.log(e)
  }

  // redirect home page to main page
  createPage({
    path: `/`,
    component: templates["index"],
    context: {
      slug: `/`,
      gitRemote: {
        org: gitRemote.organization,
        name: gitRemote.name,
        branch: gitRemote.ref,
      },
    },
  })

  await processOpenApiFiles(
    "json",
    graphql,
    createPage,
    gitRemote,
    parliamentNavigation
  )
  await processOpenApiFiles(
    "yaml",
    graphql,
    createPage,
    gitRemote,
    parliamentNavigation
  )
}

const processOpenApiFiles = async (
  extension,
  graphql,
  createPage,
  gitRemote,
  parliamentNavigation
) => {
  const openapiTemplate = path.resolve(`src/templates/openapi.js`)
  const type = extension === "json" ? `"json"` : `"yaml", "yml"`
  try {
    let { data } = await graphql(`
      query {
        allFile(filter: { extension: { in: [${type}] } }) {
          edges {
            node {
              absolutePath
              name
              ext
              internal {
                content
              }
            }
          }
        }
      }
    `)
    if (data.allFile.edges.length > 0) {
      await asyncForEach(data.allFile.edges, async ({ node }) => {
        let filepath = node.absolutePath
        let ext = node.ext
        let content = node.internal.content
        let seo = searchTree(
          parliamentNavigation.pages,
          `${node.name}${node.ext}`
        )
        try {
          let openapi = false
          if (ext === ".json") {
            let json = JSON.parse(content)
            if (json.openapi || json.swagger) {
              openapi = true
            }
          } else {
            let yaml = YAML.parse(content)
            if (yaml.openapi || yaml.swagger) {
              openapi = true
            }
          }
          if (openapi) {
            try {
              const swaggerObject = await SwaggerParser.bundle(filepath)
              if (Object.keys(swaggerObject.paths).includes("")) {
                swaggerObject.paths = renameProp("", "/", swaggerObject.paths)
              }
              await createOpenApiPage(
                createPage,
                openapiTemplate,
                swaggerObject,
                filepath,
                seo,
                gitRemote
              )
            } catch (e) {
              console.log(
                `Error parsing the OpenAPI spec at ${filepath}, please fix the below error`
              )
              console.log(e.message)
            }
          }
        } catch (e) {
          // console.log("Error parsing the file: " + filepath)
          // console.log(e.message)
        }
      })
    }
  } catch (e) {
    console.log(`Skipping ${type} files`)
    console.log(e)
  }
}

const createOpenApiPage = async (
  createPage,
  openapiTemplate,
  object,
  filepath,
  seo,
  gitRemote
) => {
  if (object && (object.swagger || object.openapi)) {
    let slug = filepath

    const localFilePath = path.relative(
      `${process.env.LOCAL_PROJECT_DIRECTORY}`,
      filepath
    )
    const directories = localFilePath.split(path.sep)
    slug = path.join("/", ...directories)

    try {
      const targets = [
        "shell_curl",
        "node_fetch",
        "php_http1",
        "java_unirest",
        "go_native",
        "python_python3",
        "csharp_restsharp",
        "ruby_native",
      ]
      const result = openApiSnippet.getSnippets(object, targets)
      const keys = Object.keys(object.paths)
      keys.forEach((key) => {
        let res = result.filter(function (res) {
          return res.url.endsWith(key)
        })
        let methodKeys = Object.keys(object.paths[key])
        methodKeys.forEach((methodKey) => {
          let methodRes = res.find(function (methodRes) {
            return methodRes.method.toLowerCase() == methodKey.toLowerCase()
          })
          object.paths[key][methodKey]["x-codeSamples"] = []
          methodRes.snippets.forEach(function (snippet) {
            object.paths[key][methodKey]["x-codeSamples"].push({
              lang: snippet.id.split("_")[0],
              source: snippet.content,
            })
          })
        })
      })
    } catch (e) {
      console.log("Skipping code samples for Swagger")
    }

    createPage({
      path: slug,
      component: openapiTemplate,
      context: {
        spec: object,
        seo: seo,
        gitRemote: gitRemote,
      },
    })

    // if we have the spec is in the side nav add it to search index
    if (seo) {
      // convert openapi to markdown
      const md = await converter.convert(object, {})
      // add open api spec to search index
      openApiSearchDocs.push({
        id: slug,
        title: seo,
        body: md,
        path: slug,
        type: "apis",
      })
    }
  }
}

exports.onCreateWebpackConfig = ({ actions, plugins }) => {
  actions.setWebpackConfig({
    resolve: {
      // Put main before module else it messes up react spectrum css import
      mainFields: ["browser", "module", "main"],
      fallback: {
        http: require.resolve("stream-http"),
        tty: require.resolve("tty-browserify"),
        stream: require.resolve("stream-browserify"),
        https: require.resolve("https-browserify"),
        path: require.resolve("path-browserify"),
        "to-arraybuffer": require.resolve("to-arraybuffer"),
        os: require.resolve("os-browserify/browser"),
        assert: require.resolve("assert/"),
        net: false,
        tls: false
      },
    },
    plugins: [
      plugins.provide({
        process: "process/browser",
        Buffer: ['buffer', 'Buffer'],
      }),
    ],
  })
}

/**
 * Add custom field resolvers to the GraphQL schema. Allows adding new fields to types by providing field configs,
 * or adding resolver functions to existing fields.
 *
 * We are using this to save the search index as a JSON object as we create here during build time.
 *
 * [Gatsby Node API - createResolvers]{@link https://www.gatsbyjs.org/docs/node-apis/#createResolvers}
 *
 * @param {function} createResolvers
 */
exports.createResolvers = ({ createResolvers }) => {
  createResolvers({
    Query: {
      ParliamentSearchIndex: {
        type: GraphQLJSONObject,
        async resolve(source, args, context) {
          const { entries: nodes } = await context.nodeModel.findAll({
            type: `MarkdownRemark`,
          })
          const { entries: pages } = await context.nodeModel.findAll({
            type: `ParliamentNavigation`,
          })
          return await createIndex(Array.from(nodes), Array.from(pages))
        },
      },
    },
  })
}

/**
 * Creates an elasticlunr index of all the markdown and open api documents.
 *
 * [Gatsby Node API - createResolvers]{@link https://www.gatsbyjs.org/docs/node-apis/#createResolvers}
 *
 * @param {Array} nodes An array containing all the markdown documents
 * @param {Object} pages The contents of ParliamentNavigation
 */
const createIndex = async (nodes, pages) => {
  const index = elasticlunr()
  index.setRef(`id`)
  index.addField(`title`)
  index.addField(`body`)
  index.addField(`path`)
  index.addField(`type`)
  index.addField(`group`)

  const project = []

  for (let node of nodes) {
    const { slug } = node.fields
    let title = getTitle(pages, slug, node)
    const type = slug.includes("blog/") ? "blog" : "docs"

    if (title && slug !== "/do-not-delete") {
      const doc = {
        id: slug,
        title: title,
        body: node.internal.content,
        path: slug,
        type: type,
        group: `${process.env.BUSINESS_GROUP}`,
        product: `${process.env.PRODUCT_KEY || ``}`,
        project: `${process.env.JOB_NAME}`,
      }
      index.addDoc(doc)
      const fullSitePath =
        `${process.env.GATSBY_SITE_PATH_PREFIX}/${doc.path}`.replace(
          /\/\//g,
          "/"
        )
      doc.id = fullSitePath
      doc.path = fullSitePath
      project.push(doc)
    }
  }

  // Open API specs are not in graphql db, hence this hack
  for (let spec of openApiSearchDocs) {
    index.addDoc(spec)
    const fullSitePath =
      `${process.env.GATSBY_SITE_PATH_PREFIX}/${spec.path}`.replace(
        /\/\//g,
        "/"
      )
    spec.id = fullSitePath
    spec.path = fullSitePath
    spec.group = `${process.env.BUSINESS_GROUP}`
    spec.product = `${process.env.PRODUCT_KEY || ``}`
    spec.project = `${process.env.JOB_NAME}`

    project.push(spec)
  }
  
  const projectPath = {
    id: `${process.env.GATSBY_SITE_PATH_PREFIX}`,
    title: `${process.env.GATSBY_SOURCE_TITLE}`,
    type: "docs",
    path: `${process.env.GATSBY_SITE_PATH_PREFIX}`,
    group: `${process.env.BUSINESS_GROUP}`,
    product: `${process.env.PRODUCT_KEY || ``}`,
    project: `${process.env.JOB_NAME}`,
  }
  index.addDoc(projectPath)
  project.push(projectPath)

  fs.writeFileSync("searchIndex.json", JSON.stringify(project), {
    encoding: "utf8",
  })

  return index.toJSON()
}

const getTitle = (pages, slug, node) => {
  let title = searchTree(pages, slug) || node.frontmatter?.title
  if (!title) {
    const firstLine = node?.rawMarkdownBody?.split("\n", 1)[0]
    title = firstLine?.replace(/#/g, "")
  }
  return title
}

exports.sourceNodes = async ({
  actions,
  createContentDigest,
  createNodeId,
}) => {
  const { createNode } = actions

  const blogFiles = glob.sync(
    `${process.env.LOCAL_PROJECT_DIRECTORY}/blog/**/*.md`
  )
  const docFiles = glob.sync(`${process.env.LOCAL_PROJECT_DIRECTORY}/**/*.md`, {
    ignore: blogFiles,
  })

  const data = []
  if (docFiles.length > 0) {
    data.push({ title: "Docs", path: "/" })
  }
  if (blogFiles.length > 0) {
    data.push({ title: "Blog", path: "/blog" })
  }

  data.map((tab) =>
    createNode({
      ...tab,
      id: createNodeId(`${SITE_TAB_TYPE}-${tab.title}`),
      parent: null,
      children: [],
      internal: {
        type: SITE_TAB_TYPE,
        content: JSON.stringify(tab),
        contentDigest: createContentDigest(tab),
      },
    })
  )

  return
}

exports.createSchemaCustomization = ({ actions }) => {
  const { createTypes } = actions
  const typeDefs = `
      type SiteTabs implements Node @dontInfer {
        id: ID!
        title: String!
        path: String!
      }
    `
  createTypes(typeDefs)
}
