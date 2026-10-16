export function musicSearchResponse({artist=false}={}) {
 const browse={browseEndpoint:{browseId:'UCabcdefghijklmnop',browseEndpointContextSupportedConfigs:{browseEndpointContextMusicConfig:{pageType:'MUSIC_PAGE_TYPE_ARTIST'}}}};
 const watch={watchEndpoint:{videoId:'abcdefghijk',watchEndpointMusicSupportedConfigs:{watchEndpointMusicConfig:{musicVideoType:'MUSIC_VIDEO_TYPE_ATV'}}}};
 const text=runs=>({musicResponsiveListItemFlexColumnRenderer:{text:{runs}}});
 const item={musicResponsiveListItemRenderer:{playlistItemData:{videoId:'abcdefghijk'},navigationEndpoint:artist?browse:watch,flexColumns:artist?[text([{text:'Test Artist'}]),text([{text:'Artist'}])]:[text([{text:'Soft Focus',navigationEndpoint:watch}]),text([{text:'Test Artist',navigationEndpoint:browse},{text:' • '},{text:'3:20'}])],thumbnail:{musicThumbnailRenderer:{thumbnail:{thumbnails:[{url:'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',width:480,height:360}]}}}}};
 return {contents:{tabbedSearchResultsRenderer:{tabs:[{tabRenderer:{title:'YouTube Music',selected:true,content:{sectionListRenderer:{contents:[{musicShelfRenderer:{title:{runs:[{text:artist?'Artists':'Songs'}]},contents:[item]}}]}}}}]}}};
}

export function videoSearchResponse() {
 return {contents:{twoColumnSearchResultsRenderer:{primaryContents:{sectionListRenderer:{contents:[{itemSectionRenderer:{contents:[{videoRenderer:{videoId:'abcdefghijk',title:{runs:[{text:'Soft Focus'}]},ownerText:{runs:[{text:'Test Artist',navigationEndpoint:{browseEndpoint:{browseId:'UCabcdefghijklmnop'}}}]},lengthText:{simpleText:'3:20'},viewCountText:{simpleText:'12345 views'},thumbnail:{thumbnails:[{url:'https://i.ytimg.com/test.jpg',width:480,height:360}]}}}]}}]}}}}};
}
