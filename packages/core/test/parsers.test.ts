import { describe, expect, it } from 'vitest';
import { parseFile, scanSource } from '@repomind/core';

describe('scanner', () => {
  it('blanks comments and strings but preserves offsets', () => {
    const src = 'val a = "class Fake" // fun hidden()\nfun real() {}\n/* class Nope */';
    const { code, noComments } = scanSource(src, { comments: 'c', nestedBlock: true });
    expect(code.length).toBe(src.length);
    expect(code).not.toContain('Fake');
    expect(code).not.toContain('hidden');
    expect(code).toContain('fun real()');
    expect(noComments).toContain('"class Fake"');
    expect(noComments).not.toContain('Nope');
  });

  it('handles rust lifetimes and raw strings', () => {
    const src = "fn f<'a>(x: &'a str) -> &'a str { let s = r#\"fn fake()\"#; x }";
    const { code } = scanSource(src, { comments: 'c', rustRaw: true });
    expect(code).toContain("fn f<'a>");
    expect(code).not.toContain('fake');
  });
});

describe('kotlin parser', () => {
  const src = `
package com.example.app

import com.example.data.Repo
import kotlinx.coroutines.flow.*

@HiltViewModel
class LoginViewModel(private val repo: Repo) : ViewModel() {
    private val secret = 1
    fun login(user: String, pass: String): Boolean {
        val local = 3
        return repo.check(user, pass)
    }
    suspend fun logout() = repo.clear()
}

@Composable
fun LoginScreen(vm: LoginViewModel) {
    val x = R.string.login_title
}

data class User(val id: Long, val name: String)
const val MAX_TRIES = 3
fun String.isEmail(): Boolean = contains("@")
private fun helper() {}
`;
  const r = parseFile('app/src/main/java/com/example/app/Login.kt', 'kotlin', src);
  const byName = Object.fromEntries(r.symbols.map((s) => [s.name, s]));

  it('extracts package and imports', () => {
    expect(r.pkg).toBe('com.example.app');
    expect(r.imports.map((i) => i.spec)).toEqual(['com.example.data.Repo', 'kotlinx.coroutines.flow.*']);
  });
  it('classifies Android-specific declarations', () => {
    expect(byName['LoginViewModel']?.kind).toBe('viewmodel');
    expect(byName['LoginScreen']?.kind).toBe('composable');
    expect(byName['User']?.kind).toBe('class');
    expect(byName['MAX_TRIES']?.kind).toBe('constant');
  });
  it('tracks methods, return types and visibility', () => {
    expect(byName['login']).toMatchObject({ kind: 'method', container: 'LoginViewModel', returnType: 'Boolean' });
    expect(byName['logout']?.kind).toBe('method');
    expect(byName['helper']?.exported).toBe(false);
    expect(byName['isEmail']).toMatchObject({ kind: 'function', container: 'String', returnType: 'Boolean' });
  });
  it('ignores locals inside function bodies', () => {
    expect(byName['local']).toBeUndefined();
    expect(byName['x']).toBeUndefined();
  });
  it('captures Android resource references', () => {
    expect(r.resourceRefs).toContain('string/login_title');
  });
});

describe('java parser', () => {
  const src = `
package com.example;
import java.util.List;
import com.example.model.Item;

public class ItemService implements Service {
    public static final int LIMIT = 10;
    private final List<Item> items;
    public ItemService(List<Item> items) { this.items = items; }
    public List<Item> findAll(String filter) {
        if (filter == null) { return items; }
        return items;
    }
    private void hidden() {}
    public static void main(String[] args) {}
}
interface Service { List<Item> findAll(String filter); }
`;
  const r = parseFile('src/main/java/com/example/ItemService.java', 'java', src);
  it('extracts types, methods, fields and main', () => {
    const names = r.symbols.map((s) => `${s.kind}:${s.container ?? ''}.${s.name}`);
    expect(names).toContain('class:.ItemService');
    expect(names).toContain('method:ItemService.findAll');
    expect(names).toContain('constant:ItemService.LIMIT');
    expect(names).toContain('interface:.Service');
    expect(r.symbols.find((s) => s.name === 'findAll')?.returnType).toBe('List<Item>');
    expect(r.symbols.find((s) => s.name === 'hidden')?.exported).toBe(false);
    expect(r.hasMain).toBe(true);
  });
});

describe('typescript parser', () => {
  const src = `
import React, { useState } from 'react';
import type { User } from './types';
import * as api from "../api/client";
export { helper } from './helper';
const lazy = await import('./lazy');
const fs = require('fs');

export interface Props { user: User }
export type Id = string;
export enum Color { Red }
export const MAX = 5;
export async function load(id: Id): Promise<User> { return api.get(id); }
export const handler = async (req: Request): Promise<Response> => new Response();
class Store {
  private items: string[] = [];
  add(item: string): void { const inner = 1; this.items.push(item); }
  get size(): number { return this.items.length; }
}
export default Store;
function internal() {}
`;
  const r = parseFile('src/app.ts', 'typescript', src);
  it('extracts all import forms', () => {
    const specs = r.imports.map((i) => `${i.kind}:${i.spec}`);
    expect(specs).toEqual(expect.arrayContaining(['import:react', 'import:./types', 'import:../api/client', 'reexport:./helper', 'dynamic:./lazy', 'require:fs']));
    expect(r.imports.find((i) => i.spec === 'react')?.names).toEqual(expect.arrayContaining(['useState', 'default']));
  });
  it('extracts declarations with export flags', () => {
    const s = Object.fromEntries(r.symbols.map((x) => [x.name, x]));
    expect(s['Props']).toMatchObject({ kind: 'interface', exported: true });
    expect(s['load']).toMatchObject({ kind: 'function', exported: true, returnType: 'Promise<User>' });
    expect(s['handler']?.kind).toBe('function');
    expect(s['MAX']?.kind).toBe('constant');
    expect(s['add']).toMatchObject({ kind: 'method', container: 'Store' });
    expect(s['internal']?.exported).toBe(false);
    expect(s['inner']).toBeUndefined();
  });
});

describe('python parser', () => {
  const src = `
from .models import User, Account
from app.services import (
    billing,
    email as mail,
)
import os, json

API_URL = "x"

@dataclass
class Service:
    def run(self, x: int) -> str:
        def inner():
            pass
        return ""

async def main() -> None:
    pass

if __name__ == "__main__":
    main()
`;
  const r = parseFile('app/service.py', 'python', src);
  it('parses imports including parenthesized lists', () => {
    expect(r.imports.find((i) => i.spec === '.models')?.names).toEqual(['User', 'Account']);
    expect(r.imports.find((i) => i.spec === 'app.services')?.names).toEqual(['billing', 'email']);
    expect(r.imports.map((i) => i.spec)).toEqual(expect.arrayContaining(['os', 'json']));
  });
  it('extracts classes, methods and detects __main__', () => {
    const s = Object.fromEntries(r.symbols.map((x) => [x.name, x]));
    expect(s['Service']?.annotations).toContain('dataclass');
    expect(s['run']).toMatchObject({ kind: 'method', container: 'Service', returnType: 'str' });
    expect(s['inner']).toBeUndefined();
    expect(s['API_URL']?.kind).toBe('constant');
    expect(r.hasMain).toBe(true);
  });
});

describe('rust / go / c parsers', () => {
  it('rust', () => {
    const r = parseFile('src/main.rs', 'rust', `
mod config;
use crate::config::Settings;
use std::collections::{HashMap, HashSet};
pub struct App { settings: Settings }
impl App {
    pub fn new() -> Self { let inner = 1; App { settings: Settings::default() } }
}
pub trait Runner { fn run(&self) -> Result<(), String>; }
fn main() {}
`);
    expect(r.imports.map((i) => `${i.kind}:${i.spec}`)).toEqual(expect.arrayContaining(['mod:config', 'use:crate::config::Settings']));
    const s = Object.fromEntries(r.symbols.map((x) => [x.name, x]));
    expect(s['new']).toMatchObject({ kind: 'method', container: 'App', returnType: 'Self' });
    expect(s['App']?.kind).toBe('struct');
    expect(s['Runner']?.kind).toBe('trait');
    expect(r.hasMain).toBe(true);
  });
  it('go', () => {
    const r = parseFile('cmd/server/main.go', 'go', `
package main

import (
\t"fmt"
\tsrv "example.com/app/internal/server"
)

type Config struct { Port int }
type (
\tHandler interface { Serve() error }
)
const Version = "1"
func (c *Config) Addr() string { return fmt.Sprint(c.Port) }
func main() { srv.Run() }
`);
    expect(r.imports.map((i) => i.spec)).toEqual(['fmt', 'example.com/app/internal/server']);
    const s = Object.fromEntries(r.symbols.map((x) => [x.name, x]));
    expect(s['Addr']).toMatchObject({ kind: 'method', container: 'Config', returnType: 'string', exported: true });
    expect(s['Handler']?.kind).toBe('interface');
    expect(r.hasMain).toBe(true);
  });
  it('c', () => {
    const r = parseFile('src/util.c', 'c', `
#include <stdio.h>
#include "util.h"
#define MAX 10
static int helper(int x) { return x; }
int add(int a, int b)
{
    if (a) { return a + b; }
    return b;
}
struct point { int x; };
`);
    expect(r.imports.map((i) => i.spec)).toEqual(['<stdio.h>', 'util.h']);
    const names = r.symbols.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['MAX', 'helper', 'add', 'point']));
    expect(r.symbols.find((x) => x.name === 'helper')?.exported).toBe(false);
  });
});

describe('build file parsers', () => {
  it('gradle kts dependencies, plugins and android block', () => {
    const r = parseFile('app/build.gradle.kts', 'gradle-kts', `
plugins { alias(libs.plugins.android.application); id("org.jetbrains.kotlin.android") }
android { namespace = "com.x"; compileSdk = 35; defaultConfig { minSdk = 26; targetSdk = 35 } }
dependencies {
  implementation(project(":core:data"))
  implementation(projects.feature.loginUi)
  implementation("com.squareup.retrofit2:retrofit:2.11.0")
  implementation(libs.androidx.core.ktx)
}`);
    expect(r.build?.projectDeps).toEqual([':core:data', ':feature:login-ui']);
    expect(r.build?.deps).toEqual(['com.squareup.retrofit2:retrofit:2.11.0']);
    expect(r.build?.catalogDeps).toEqual(['androidx.core.ktx']);
    expect(r.build?.android).toMatchObject({ namespace: 'com.x', compileSdk: '35', minSdk: '26', targetSdk: '35' });
    expect(r.build?.plugins).toContain('catalog:android.application');
  });
  it('groovy settings includes', () => {
    const r = parseFile('settings.gradle', 'gradle', `rootProject.name = 'X'\ninclude ':app', ':lib'\ninclude(":feature:a")`);
    expect(r.build?.includes).toEqual([':app', ':lib', ':feature:a']);
    expect(r.build?.rootName).toBe('X');
  });
  it('version catalog', () => {
    const r = parseFile('gradle/libs.versions.toml', 'toml', `[versions]\nroom = "2.6.1"\n[libraries]\nroom-runtime = { module = "androidx.room:room-runtime", version.ref = "room" }\njunit = "junit:junit:4.13.2"\n[plugins]\nandroid-application = { id = "com.android.application", version = "8.7.0" }`);
    expect(r.build?.catalog).toMatchObject({ 'room.runtime': 'androidx.room:room-runtime:2.6.1', junit: 'junit:junit:4.13.2', 'plugins.android.application': 'com.android.application:8.7.0' });
  });
  it('android manifest components', () => {
    const r = parseFile('app/src/main/AndroidManifest.xml', 'android-manifest', `<manifest package="com.x"><uses-permission android:name="android.permission.CAMERA"/><application android:name=".App"><activity android:name=".Main"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity><service android:name=".Sync"/></application></manifest>`);
    expect(r.build?.components).toEqual([
      { kind: 'application', name: '.App', launcher: false },
      { kind: 'activity', name: '.Main', launcher: true },
      { kind: 'service', name: '.Sync', launcher: false }
    ]);
    expect(r.build?.permissions).toEqual(['android.permission.CAMERA']);
  });
  it('package.json', () => {
    const r = parseFile('package.json', 'json', JSON.stringify({ name: 'x', main: 'dist/index.js', bin: { x: 'bin/x.js' }, scripts: { test: 'vitest' }, dependencies: { react: '^19', local: 'workspace:*' } }));
    expect(r.build?.deps).toEqual(['react@^19']);
    expect(r.build?.projectDeps).toEqual(['local']);
    expect(r.build?.entry?.map((e) => e.detail)).toEqual(['dist/index.js', 'bin/x.js']);
  });
  it('never throws on garbage', () => {
    expect(() => parseFile('x.kt', 'kotlin', '}}}{{{ class ( fun')).not.toThrow();
    expect(parseFile('package.json', 'json', '{nope').fidelity).toBe('none');
  });
});
