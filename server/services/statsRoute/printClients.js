const printVersionHtml = client => (html, version) => (
    html + `<li><strong>${name}</strong> ${version} : ${client[version]}</li>\n`
)

function printClient(html, client) {
    const printClientHtml = printVersionHtml(client);
    const clientHtml = 
            Object.values(client).reduce(printClientHtml, html)

    return clientHtml;
};

function printClients(clients) {
  const initialHtml = "<ul>\n";
  const contentHtml = Object.values(clients).reduce(printClient, initialHtml)
  const html = contentHtml + "</ul>"

  return html
}

module.exports = printClients