import test from 'node:test';
import assert from 'node:assert/strict';
import {videoShortcutCode} from './videoKeyboard.js';

test('Android key-only events recover letters, top-row digits and navigation',()=>{
  for(const [key,code] of [['h','KeyH'],['F','KeyF'],['s','KeyS'],['4','Digit4'],[' ','Space'],['Escape','Escape'],['ArrowRight','ArrowRight']]) {
    assert.equal(videoShortcutCode({key,code:''}),code);
    assert.equal(videoShortcutCode({key,code:'Unidentified'}),code);
  }
  assert.equal(videoShortcutCode({key:'2',location:3}),'Numpad2');
});
test('physical codes survive, and legacy hardware fallback excludes text composition',()=>{
  assert.equal(videoShortcutCode({key:'2',code:'Numpad2'}),'Numpad2');
  assert.equal(videoShortcutCode({keyCode:72}),'KeyH');
  assert.equal(videoShortcutCode({keyCode:52}),'Digit4');
  assert.equal(videoShortcutCode({keyCode:100}),'Numpad4');
  assert.equal(videoShortcutCode({key:'h',isComposing:true}),'');
  assert.equal(videoShortcutCode({key:'h',code:'KeyH',keyCode:229}),'');
});
