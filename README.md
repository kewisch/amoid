amoid
=====

This is a simple tool to convert between the various AMO identifier formats: the database id, the
add-on guid, and the slug.

Installation
------------
This module is not on npmjs yet. To install, you can run `npm install -g .` in the cloned directory,
or `npm link` in case you want to make changes to the sources.

Configuration
-------------

amoid requires access to redash, which requires an API key to be configured. If you make use of
[pyamo](https://github.com/kewisch/pyamo) you will already have the redash config.

To create the config, you can add a `~/.amorc` (or `%HOME%/amorc.ini` on Windows). You'll need to
set your redash user api key (not the query key):

```
{
  "auth": {
    "redash_key": "42c85d86fd212538f4394f47c80fa62c"
  }
}
```

Examples
--------

Convert guids from a file to show the id, guid and slug. Since there are multiple output formats,
they will be displayed as CSV with commas escaped. The first line will be the CSV header.

```
cat guids | amoid
cat guids | amoid -i guid
cat guids | amoid -i guid -o id -o guid -o slug
```

Convert slugs from the command line to their database ids. The output will be just the guids not
escaped in any way, since there is only one output format.

```
amoid -i slug -o id amo-queue-helper ideal-size
```

Convert ids from a file to their guids. Again not using CSV given there is one output format.
```
cat ids | amoid -i id -o guid
```
