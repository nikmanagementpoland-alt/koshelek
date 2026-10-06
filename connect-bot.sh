#!/bin/zsh
# Подключает Mini App к твоему боту: кнопка «Кошелёк» слева от поля ввода.
# Ключ бота берётся из ~/Desktop/деньги.rtf и никуда, кроме api.telegram.org, не отправляется.
set -e
URL="${1:?Укажи адрес приложения, например https://user.github.io/koshelek/}"
TOKEN=$(textutil -convert txt -stdout ~/Desktop/деньги.rtf | grep -oE '[0-9]{8,12}:[A-Za-z0-9_-]{30,}' | head -1)
[ -z "$TOKEN" ] && { echo "Ключ не найден в деньги.rtf"; exit 1; }
api() { curl -s "https://api.telegram.org/bot$TOKEN/$1" -H 'Content-Type: application/json' -d "$2"; echo; }
api setChatMenuButton "{\"menu_button\":{\"type\":\"web_app\",\"text\":\"Кошелёк\",\"web_app\":{\"url\":\"$URL\"}}}"
api setMyDescription '{"description":"Личный кошелёк: сколько можно сегодня, конверты, анализ трат. Нажми кнопку «Кошелёк» внизу."}'
api getMe '{}' | grep -oE '"username":"[^"]+"'
