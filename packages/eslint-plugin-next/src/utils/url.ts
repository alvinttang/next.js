import * as path from 'path'
import * as fs from 'fs'
import findUp from 'next/dist/compiled/find-up'

// Cache for fs.readdirSync lookup.
// Prevent multiple blocking IO requests that have already been calculated.
const fsReadDirSyncCache = {}

// Default page extensions used by Next.js
const DEFAULT_PAGE_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js']

/**
 * Get pageExtensions from next.config.js
 */
function getPageExtensions(dir: string): string[] {
  const cacheKey = 'pageExtensions'
  
  // Check cache first
  if ((getPageExtensions as any).cache?.[cacheKey]) {
    return (getPageExtensions as any).cache[cacheKey]
  }

  try {
    // Find next.config.js in the directory tree
    const configPath = findUp.sync('next.config.js', { cwd: dir })
    
    if (!configPath) {
      return DEFAULT_PAGE_EXTENSIONS
    }

    // Try to read and parse the config
    // We use a simple approach to avoid eval/security issues
    const configContent = fs.readFileSync(configPath, 'utf8')
    
    // Look for pageExtensions in the config
    const pageExtensionsMatch = configContent.match(/pageExtensions\s*:\s*\[([^\]]+)\]/)
    
    if (pageExtensionsMatch) {
      // Extract the array content and parse individual extensions
      const extensionsStr = pageExtensionsMatch[1]
      const extensions = extensionsStr
        .match(/['"]([^'"]+)['"]/g)
        ?.map(ext => ext.replace(/['"]/g, '')) ?? []
      
      if (extensions.length > 0) {
        if (!(getPageExtensions as any).cache) {
          (getPageExtensions as any).cache = {}
        }
        (getPageExtensions as any).cache[cacheKey] = extensions
        return extensions
      }
    }
  } catch (e) {
    // If anything fails, return default extensions
  }

  return DEFAULT_PAGE_EXTENSIONS
}

/**
 * Get the regex pattern for matching page files
 */
function getPageExtensionsPattern(dir: string): RegExp {
  const extensions = getPageExtensions(dir)
  const extPattern = extensions.map(ext => `\\.${ext}`).join('|')
  return new RegExp(`(${extPattern})$`)
}

/**
 * Recursively parse directory for page URLs.
 */
function parseUrlForPages(urlprefix: string, directory: string) {
  fsReadDirSyncCache[directory] ??= fs.readdirSync(directory, {
    withFileTypes: true,
  })
  const res = []
  const pageExtPattern = getPageExtensionsPattern(directory)
  
  fsReadDirSyncCache[directory].forEach((dirent) => {
    if (pageExtPattern.test(dirent.name)) {
      // Check for index files with any configured extension
      const indexMatch = dirent.name.match(/^index(\.[^.]+)$/)
      if (indexMatch) {
        res.push(`${urlprefix}${dirent.name.replace(/^index(\.[^.]+)$/, '')}`)
      }
      // Remove the extension
      const nameWithoutExt = dirent.name.replace(pageExtPattern, '')
      res.push(`${urlprefix}${nameWithoutExt}`)
    } else {
      const dirPath = path.join(directory, dirent.name)
      if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
        res.push(...parseUrlForPages(urlprefix + dirent.name + '/', dirPath))
      }
    }
  })
  return res
}

/**
 * Recursively parse app directory for URLs.
 */
function parseUrlForAppDir(urlprefix: string, directory: string) {
  fsReadDirSyncCache[directory] ??= fs.readdirSync(directory, {
    withFileTypes: true,
  })
  const res = []
  const pageExtPattern = getPageExtensionsPattern(directory)
  
  fsReadDirSyncCache[directory].forEach((dirent) => {
    if (pageExtPattern.test(dirent.name)) {
      // Check for page files with any configured extension
      const pageMatch = dirent.name.match(/^page(\.[^.]+)$/)
      if (pageMatch) {
        const nameWithoutExt = dirent.name.replace(/^page(\.[^.]+)$/, '')
        res.push(`${urlprefix}${nameWithoutExt}`)
      } else {
        // Check for layout files - they should be ignored
        const layoutMatch = dirent.name.match(/^layout(\.[^.]+)$/)
        if (!layoutMatch) {
          const nameWithoutExt = dirent.name.replace(pageExtPattern, '')
          res.push(`${urlprefix}${nameWithoutExt}`)
        }
      }
    } else {
      const dirPath = path.join(directory, dirent.name)
      if (dirent.isDirectory(dirPath) && !dirent.isSymbolicLink()) {
        res.push(...parseUrlForPages(urlprefix + dirent.name + '/', dirPath))
      }
    }
  })
  return res
}

/**
 * Takes a URL and does the following things.
 *  - Replaces `index.html` with `/`
 *  - Makes sure all URLs are have a trailing `/`
 *  - Removes query string
 */
export function normalizeURL(url: string) {
  if (!url) {
    return
  }
  url = url.split('?', 1)[0]
  url = url.split('#', 1)[0]
  url = url = url.replace(/(\/index\.html)$/, '/')
  // Empty URLs should not be trailed with `/`, e.g. `#heading`
  if (url === '') {
    return url
  }
  url = url.endsWith('/') ? url : url + '/'
  return url
}

/**
 * Normalizes an app route so it represents the actual request path. Essentially
 * performing the following transformations:
 *
 * - `/(dashboard)/user/[id]/page` to `/user/[id]`
 * - `/(dashboard)/account/page` to `/account`
 * - `/user/[id]/page` to `/user/[id]`
 * - `/account/page` to `/account`
 * - `/page` to `/`
 * - `/(dashboard)/user/[id]/route` to `/user/[id]`
 * - `/(dashboard)/account/route` to `/account`
 * - `/user/[id]/route` to `/user/[id]`
 * - `/account/route` to `/account`
 * - `/route` to `/`
 * - `/` to `/`
 *
 * @param route the app route to normalize
 * @returns the normalized pathname
 */
export function normalizeAppPath(route: string) {
  return ensureLeadingSlash(
    route.split('/').reduce((pathname, segment, index, segments) => {
      // Empty segments are ignored.
      if (!segment) {
        return pathname
      }

      // Groups are ignored.
      if (isGroupSegment(segment)) {
        return pathname
      }

      // Parallel segments are ignored.
      if (segment[0] === '@') {
        return pathname
      }

      // The last segment (if it's a leaf) should be ignored.
      if (
        (segment === 'page' || segment === 'route') &&
        index === segments.length - 1
      ) {
        return pathname
      }

      return `${pathname}/${segment}`
    }, '')
  )
}

/**
 * Gets the possible URLs from a directory.
 */
export function getUrlFromPagesDirectories(
  urlPrefix: string,
  directories: string[]
) {
  return Array.from(
    // De-duplicate similar pages across multiple directories.
    new Set(
      directories
        .flatMap((directory) => parseUrlForPages(urlPrefix, directory))
        .map(
          // Since the URLs are normalized we add `^` and `$` to the RegExp to make sure they match exactly.
          (url) => `^${normalizeURL(url)}$`
        )
    )
  ).map((urlReg) => {
    urlReg = urlReg.replace(/\[.*\]/g, '((?!.+?\\..+?).*?)')
    return new RegExp(urlReg)
  })
}

export function getUrlFromAppDirectory(
  urlPrefix: string,
  directories: string[]
) {
  return Array.from(
    // De-duplicate similar pages across multiple directories.
    new Set(
      directories
        .map((directory) => parseUrlForAppDir(urlPrefix, directory))
        .flat()
        .map(
          // Since the URLs are normalized we add `^` and `$` to the RegExp to make sure they match exactly.
          (url) => `^${normalizeAppPath(url)}$`
        )
    )
  ).map((urlReg) => {
    urlReg = urlReg.replace(/\[.*\]/g, '((?!.+?\\..+?).*?)')
    return new RegExp(urlReg)
  })
}

export function execOnce<TArgs extends any[], TResult>(
  fn: (...args: TArgs) => TResult
): (...args: TArgs) => TResult {
  let used = false
  let result: TResult

  return (...args: TArgs) => {
    if (!used) {
      used = true
      result = fn(...args)
    }
    return result
  }
}

function ensureLeadingSlash(route: string) {
  return route.startsWith('/') ? route : `/${route}`
}

function isGroupSegment(segment: string) {
  return segment[0] === '(' && segment.endsWith(')')
}
