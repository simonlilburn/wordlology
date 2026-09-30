import { mount } from 'svelte';
import App from './App.svelte';
import './app/global.css';
import { init } from './app/init';

const target = document.getElementById('app')!;
mount(App, { target });
void init();
